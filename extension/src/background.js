/**
 * Service Worker：解码弹幕帧 → 归一化事件 → 落库 → 通知面板。
 */
import initBrotli, { decompress as brotliDecompress } from '../vendor/brotli_dec_wasm.js';
import { decodeFrame } from './common/protocol.js';
import { normalizeMessage, extractRoomMeta, extractSeats, diffSeats } from './common/normalize.js';
import { appendEvents, putSession, getSession, listSessions } from './common/store.js';
import { resolveSpeaker } from './common/attribution.js';
import { fmtDateTime } from './common/format.js';

const sessionsByTab = new Map(); // tabId -> runtime state
const roomToTab = new Map(); // roomId -> tabId
let brotliReady = null;
let engineStatus = { state: 'idle', progress: 0, error: '', segments: 0, lastText: '', rooms: 0 };
let offscreenCreating = null;

async function ensureOffscreen() {
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  } catch {
    /* ignore */
  }
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = chrome.offscreen
    .createDocument({
      url: 'src/offscreen.html',
      reasons: ['WORKERS'],
      justification: '在本地运行中文语音识别（不依赖 B 站 ASR）',
    })
    .catch((e) => {
      const msg = String((e && e.message) || e);
      if (!/single offscreen|already/i.test(msg)) console.warn('create offscreen failed', e);
    })
    .finally(() => {
      offscreenCreating = null;
    });
  return offscreenCreating;
}

function ensureBrotli() {
  if (!brotliReady) brotliReady = initBrotli();
  return brotliReady;
}

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

function newRuntime(tabId, roomId, title, url) {
  const startedAt = Date.now();
  return {
    tabId,
    roomId: String(roomId || ''),
    sessionId: `${roomId || 'unknown'}-${startedAt}-t${tabId}`,
    title: title || '',
    url: url || '',
    startedAt,
    seq: 0,
    counts: { asr: 0, danmu: 0, gift: 0, sc: 0, seat: 0, stat: 0, raw: 0 },
    seats: [],
    meta: null,
    recordings: [],
    dedupe: new Set(),
    diag: { lastFrameAt: 0, framesTotal: 0, pollOk: null, pollError: '', paused: false, updatedAt: 0 },
    lastSavedAt: 0,
    lastBiliAsrAt: 0,
    asrEnabled: null,
    autoTapped: false,
  };
}

function recordOf(rt, status = 'recording') {
  return {
    id: rt.sessionId,
    tabId: rt.tabId,
    roomId: rt.roomId,
    title: (rt.meta && rt.meta.title) || rt.title || '',
    anchor: (rt.meta && rt.meta.anchor) || '',
    url: rt.url || `https://live.bilibili.com/${rt.roomId}`,
    meta: rt.meta,
    startedAt: rt.startedAt,
    endedAt: status === 'ended' ? rt.endedAt || Date.now() : 0,
    lastEventAt: rt.diag.lastFrameAt || rt.startedAt,
    counts: rt.counts,
    diag: rt.diag,
    initialSeats: rt.initialSeats || [],
    bizSessionId: rt.bizSessionId || '',
    asrEnabled: rt.asrEnabled,
    recordings: rt.recordings || [],
    status,
  };
}

async function saveSession(rt, force = false) {
  const now = Date.now();
  if (!force && now - rt.lastSavedAt < 1500) return;
  rt.lastSavedAt = now;
  try {
    await putSession(recordOf(rt));
    chrome.runtime.sendMessage({ type: 'session-updated', session: recordOf(rt) }).catch(() => {});
  } catch (e) {
    console.error('saveSession failed', e);
  }
}

async function finalize(rt, status = 'ended') {
  rt.endedAt = Date.now();
  try {
    // 标签页关闭/离开时，把还没落盘的录音收尾
    chrome.runtime.sendMessage({ type: 'audio-finalize-room', tabId: rt.tabId, roomId: rt.roomId, title: rt.title }).catch(() => {});
    await putSession(recordOf(rt, status === 'closed' ? 'ended' : status));
    chrome.runtime.sendMessage({ type: 'session-updated', session: recordOf(rt, 'ended') }).catch(() => {});
  } catch (e) {
    console.error('finalize failed', e);
  }
  setTimeout(maybeCloseOffscreen, 60000);
}

/** 没有房间在录了就把离屏文档关掉，释放本地识别占用的内存（约 1GB）。 */
async function maybeCloseOffscreen() {
  if (sessionsByTab.size > 0) return;
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.closeDocument();
      engineStatus = { state: 'idle', progress: 0, error: '', segments: 0, lastText: '', rooms: 0 };
    }
  } catch (e) {
    console.warn('close offscreen failed', e);
  }
}

async function pushEvents(rt, events) {
  if (!events.length) return;
  for (const e of events) {
    e.seq = ++rt.seq;
    e.sid = rt.sessionId;
    if (e.kind in rt.counts) rt.counts[e.kind] += 1;
  }
  rt.diag.lastFrameAt = events[events.length - 1].t;
  try {
    await appendEvents(rt.sessionId, events);
  } catch (e) {
    console.error('appendEvents failed', e);
  }
  await saveSession(rt);
}

function dedupeDanmu(rt, e) {
  if (e.kind !== 'danmu' || !e.id) return false;
  if (rt.dedupe.has(e.id)) return true;
  rt.dedupe.add(e.id);
  if (rt.dedupe.size > 8000) {
    // 简单的容量控制：清掉最早的一半
    const it = rt.dedupe.values();
    for (let i = 0; i < 4000; i += 1) rt.dedupe.delete(it.next().value);
  }
  return false;
}

async function handleFrames(tabId, msg) {
  let rt = sessionsByTab.get(tabId);
  if (!rt) {
    rt = newRuntime(tabId, msg.roomId, msg.title, msg.url);
    sessionsByTab.set(tabId, rt);
    await saveSession(rt, true);
  }
  if (msg.roomId && rt.roomId && String(msg.roomId) !== rt.roomId) {
    // 同一个标签页换了房间
    await finalize(rt);
    rt = newRuntime(tabId, msg.roomId, msg.title, msg.url);
    sessionsByTab.set(tabId, rt);
    await saveSession(rt, true);
  }
  if (msg.title && !rt.meta) rt.title = msg.title;
  rt.diag.framesTotal += msg.frames.length;

  await ensureBrotli();
  const collected = [];
  for (const frame of msg.frames) {
    let packets;
    try {
      packets = await decodeFrame(b64ToBytes(frame.b64), (b) => brotliDecompress(b));
    } catch (e) {
      rt.diag.decodeErrors = (rt.diag.decodeErrors || 0) + 1;
      console.warn('decode frame failed', e);
      continue;
    }
    for (const p of packets) {
      if (!p.json || !p.json.cmd) continue;
      rt.diag.messages = (rt.diag.messages || 0) + 1;
      let events;
      try {
        events = normalizeMessage(p.json, frame.recvAt || Date.now());
      } catch (e) {
        continue;
      }
      for (const e of events) {
        if (dedupeDanmu(rt, e)) continue;
        collected.push(e);
      }
    }
  }
  if (collected.some((e) => e.kind === 'asr' && e.source !== 'local')) {
    rt.lastBiliAsrAt = Date.now();
    rt.asrEnabled = true;
    stopLocalAsr(tabId, rt);
  }
  if (collected.length) await pushEvents(rt, collected);
  else await saveSession(rt);
}

/** B 站 ASR 已经在了，就停掉本地旁听，避免重复记录。 */
function stopLocalAsr(tabId, rt) {
  if (!rt || !rt.diag || !rt.diag.tap || !rt.diag.tap.on) return;
  try {
    chrome.tabs.sendMessage(tabId, { type: 'local-asr-off' }).catch(() => {});
  } catch {
    /* ignore */
  }
  rt.diag.tap = { ...(rt.diag.tap || {}), on: false, reason: 'bili-asr' };
}

async function handleSnapshot(tabId, msg) {
  let rt = sessionsByTab.get(tabId);
  if (!rt) {
    rt = newRuntime(tabId, msg.roomId, '', '');
    sessionsByTab.set(tabId, rt);
    await saveSession(rt, true);
  }
  const data = msg.data;
  const meta = extractRoomMeta(data);
  const at = msg.at || Date.now();
  if (meta) {
    rt.meta = { ...(rt.meta || {}), ...meta };
    if (meta.title) rt.title = meta.title;
    if (meta.roomId) rt.roomId = String(meta.roomId);
  }
  const seats = extractSeats(data);
  const events = [];

  // 第一次拿到座位快照：只作为「记录开始时已在麦上」的基线，不产生上麦事件
  if (!rt.seatInited) {
    rt.seatInited = true;
    if (seats.length) {
      rt.seats = seats;
      if (!rt.initialSeats || !rt.initialSeats.length) {
        rt.initialSeats = seats.map((s) => ({ uid: s.uid, name: s.name, position: s.position, joinTime: s.joinTime, single: !!s.single }));
      }
    }
  } else {
    events.push(...diffSeats(rt.seats, seats, at));
    rt.seats = seats;
  }

  // 人气值（room_info.online 实际是热度，不是在线人数）
  if (meta && meta.popularity && rt.lastPopularity !== meta.popularity) {
    rt.lastPopularity = meta.popularity;
    events.push({ kind: 'stat', t: at, popularity: meta.popularity });
  }
  if (events.length) await pushEvents(rt, events);
  await saveSession(rt, true);
}

async function handleSeed(tabId, msg) {
  let rt = sessionsByTab.get(tabId);
  if (!rt) {
    rt = newRuntime(tabId, msg.roomId, msg.seed && msg.seed.room ? msg.seed.room.title : '', '');
    sessionsByTab.set(tabId, rt);
    await saveSession(rt, true);
  }
  const seed = msg.seed || {};
  const room = seed.room || {};
  if (room.roomId || room.title) {
    rt.meta = { ...(rt.meta || {}), ...room, title: room.title || (rt.meta && rt.meta.title) || rt.title };
    if (room.roomId) rt.roomId = String(room.roomId);
    if (room.title) rt.title = room.title;
  }
  if (Array.isArray(seed.seats) && seed.seats.length) {
    rt.seats = seed.seats.map((s) => ({ ...s }));
    rt.seatInited = true;
    rt.initialSeats = seed.seats.map((s) => ({ uid: s.uid, name: s.name, position: s.position, joinTime: s.joinTime, single: !!s.single }));
  }
  if (seed.bizSessionId) rt.bizSessionId = seed.bizSessionId;
  const events = [];
  if (room.online) {
    rt.lastPopularity = room.online;
    events.push({ kind: 'stat', t: msg.at || Date.now(), popularity: room.online });
  }
  if (events.length) await pushEvents(rt, events);
  else await saveSession(rt, true);
}

function handleDiag(tabId, msg) {
  const rt = sessionsByTab.get(tabId);
  if (!rt) return;
  rt.diag = {
    ...rt.diag,
    lastFrameAt: msg.lastFrameAt || rt.diag.lastFrameAt,
    framesTotal: Math.max(rt.diag.framesTotal, msg.framesTotal || 0),
    pollOk: msg.pollOk == null ? rt.diag.pollOk : msg.pollOk,
    pollError: msg.pollError || '',
    paused: !!msg.paused,
    updatedAt: Date.now(),
  };
  if (msg.tap) rt.diag.tap = msg.tap;
  // 兜底：既没检测到 B 站 ASR、也不知道房间开关状态时，等 90 秒还没有任何语音就自动开本地识别
  if (
    !rt.autoTapped &&
    rt.asrEnabled !== true &&
    rt.counts.asr === 0 &&
    rt.seats.length > 0 &&
    Date.now() - rt.startedAt > 90000
  ) {
    rt.autoTapped = true;
    try {
      chrome.tabs.sendMessage(tabId, { type: 'local-asr-on' }).catch(() => {});
    } catch {
      /* ignore */
    }
  }
  saveSession(rt, true);
}

async function handleLocalAsr(msg) {
  const roomId = String(msg.roomId || '');
  const tabId = roomToTab.get(roomId);
  const rt = tabId != null ? sessionsByTab.get(tabId) : null;
  if (!rt) return;
  // B 站 ASR 正在出字的时候，本地识别结果一律丢弃，避免同一句话记两遍
  if (rt.lastBiliAsrAt && Date.now() - rt.lastBiliAsrAt < 90000) return;
  const text = String(msg.text || '').trim();
  if (!text) return;
  const endAt = Number(msg.endAt) || Date.now();
  const startAt = Number(msg.startAt) || endAt;
  const sp = resolveSpeaker(rt.seats);
  // 单人开麦时用真实 uid，便于把连续句子并成一段；多人/全闭麦时用独立的虚拟 id，
  // 避免把不同人的话拼成一段。
  const uid = sp.confidence === 'single' ? sp.uid : `local:${Math.round(startAt)}`;
  await pushEvents(rt, [
    {
      kind: 'asr',
      source: 'local',
      t: endAt,
      dur: Math.max(0, endAt - startAt),
      uid,
      name: sp.name,
      text,
      confidence: sp.confidence,
      candidates: sp.candidates,
    },
  ]);
}

function handleEngineStatus(status) {
  engineStatus = { ...engineStatus, ...status };
  chrome.runtime.sendMessage({ type: 'asr-status', status: engineStatus }).catch(() => {});
}

const pad2 = (n) => String(n).padStart(2, '0');

function recordingFilename(rt, msg) {
  const d = new Date(msg.startedAt || Date.now());
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const raw = (rt && rt.meta && rt.meta.title) || (rt && rt.title) || msg.title || '语聊房';
  const title = String(raw).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || '语聊房';
  const ext = /mpeg|mp3/.test(String(msg.mime || '')) ? 'mp3' : 'webm';
  return `语聊房录音_${title}_${(rt && rt.roomId) || msg.roomId || ''}_${stamp}.${ext}`;
}

async function handleAudioReady(msg) {
  const tabId = msg.tabId != null ? msg.tabId : roomToTab.get(String(msg.roomId || ''));
  const rt = tabId != null ? sessionsByTab.get(tabId) : null;
  const filename = recordingFilename(rt, msg);
  let downloadId = null;
  try {
    downloadId = await chrome.downloads.download({ url: msg.url, filename, saveAs: false, conflictAction: 'uniquify' });
  } catch (e) {
    console.warn('download recording failed', e);
  }
  const item = {
    filename,
    size: msg.size || 0,
    mime: msg.mime || 'audio/webm',
    startedAt: msg.startedAt || Date.now(),
    stoppedAt: msg.stoppedAt || Date.now(),
    durationMs: msg.durationMs || 0,
    downloadId,
    savedAt: Date.now(),
  };
  if (rt) {
    rt.recordings = [...(rt.recordings || []), item];
    await saveSession(rt, true);
    chrome.runtime.sendMessage({ type: 'recording-saved', roomId: rt.roomId, tabId, item }).catch(() => {});
  }
  return item;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender && sender.tab ? sender.tab.id : (msg && msg.tabId);
  if (!msg || !msg.type) return;

  (async () => {
    try {
      switch (msg.type) {
        case 'hello': {
          let rt = sessionsByTab.get(tabId);
          if (rt && msg.roomId && rt.roomId && String(msg.roomId) !== rt.roomId) {
            await finalize(rt);
            rt = null;
          }
          if (!rt) {
            rt = newRuntime(tabId, msg.roomId, msg.title, msg.url);
            sessionsByTab.set(tabId, rt);
          } else {
            rt.title = msg.title || rt.title;
            rt.url = msg.url || rt.url;
          }
          if (msg.roomId) roomToTab.set(String(msg.roomId), tabId);
          ensureOffscreen();
          await saveSession(rt, true);
          sendResponse({ ok: true, sessionId: rt.sessionId });
          break;
        }
        case 'frames':
          await handleFrames(tabId, msg);
          sendResponse({ ok: true });
          break;
        case 'snapshot':
          await handleSnapshot(tabId, msg);
          sendResponse({ ok: true });
          break;
        case 'seed':
          await handleSeed(tabId, msg);
          if (msg.roomId) roomToTab.set(String(msg.roomId), tabId);
          ensureOffscreen();
          sendResponse({ ok: true });
          break;
        case 'ensure-offscreen':
          await ensureOffscreen();
          sendResponse({ ok: true });
          break;
        case 'asr-flag': {
          const rt = sessionsByTab.get(tabId);
          if (rt) {
            rt.asrEnabled = !!msg.enabled;
            if (msg.enabled) stopLocalAsr(tabId, rt);
          }
          sendResponse({ ok: true });
          break;
        }
        case 'pcm':
          await ensureOffscreen();
          sendResponse({ ok: true });
          break;
        case 'rec-status': {
          const rt = sessionsByTab.get(tabId);
          if (rt) {
            rt.diag.rec = msg.rec;
            saveSession(rt, true);
          }
          sendResponse({ ok: true });
          break;
        }
        case 'audio-chunk': {
          const rt = sessionsByTab.get(tabId);

          await ensureOffscreen();
          sendResponse({ ok: true });
          break;
        }
        case 'audio-stop':
          await ensureOffscreen();
          sendResponse({ ok: true });
          break;
        case 'audio-ready':
          await handleAudioReady(msg);
          sendResponse({ ok: true });
          break;
        case 'audio-empty':
          sendResponse({ ok: true });
          break;
        case 'local-asr':
          await handleLocalAsr(msg);
          sendResponse({ ok: true });
          break;
        case 'asr-engine-status':
          handleEngineStatus(msg.status || {});
          sendResponse({ ok: true });
          break;
        case 'asr-status-get':
          sendResponse({ ok: true, status: engineStatus });
          break;
        case 'diag':
          handleDiag(tabId, msg);
          sendResponse({ ok: true });
          break;
        case 'tab-gone': {
          const rt = sessionsByTab.get(tabId);
          if (rt) await finalize(rt);
          sessionsByTab.delete(tabId);
          sendResponse({ ok: true });
          break;
        }
        case 'popup-state': {
          const rt = sessionsByTab.get(tabId);
          sendResponse({ ok: true, session: rt ? recordOf(rt) : null });
          break;
        }
        case 'list-sessions': {
          const all = await listSessions();
          sendResponse({ ok: true, sessions: all });
          break;
        }
        case 'get-session': {
          const s = await getSession(msg.id);
          sendResponse({ ok: true, session: s });
          break;
        }
        default:
          sendResponse({ ok: false, error: `unknown message ${msg.type}` });
      }
    } catch (e) {
      console.error('background handler error', msg.type, e);
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rt = sessionsByTab.get(tabId);
  if (rt) {
    await finalize(rt);
    sessionsByTab.delete(tabId);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('B站语聊房记录器 installed', fmtDateTime(Date.now()));
});

// 浏览器重启 / Service Worker 冷启动后，把「标签页已不存在」的会话标记为结束
async function cleanupStaleSessions() {
  try {
    const all = await listSessions();
    const now = Date.now();
    for (const s of all) {
      if (s.status !== 'recording') continue;
      let alive = false;
      try {
        const t = await chrome.tabs.get(s.tabId);
        alive = !!t;
      } catch {
        alive = false;
      }
      const last = s.lastEventAt || s.startedAt;
      if (!alive || now - last > 6 * 3600 * 1000) {
        await putSession({ ...s, status: 'ended', endedAt: last });
      }
    }
  } catch (e) {
    console.warn('cleanupStaleSessions failed', e);
  }
}
cleanupStaleSessions();





