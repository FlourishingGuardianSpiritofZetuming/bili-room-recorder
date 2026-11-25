/**
 * 隔离世界（ISOLATED world）脚本：
 * 1. 接收 hook.js 透传的弹幕原始帧，批量转给 Service Worker；
 * 2. 用 WBI 签名定期拉取房间信息（麦位/在线人数/标题），把快照转给 Service Worker；
 * 3. 上报采集诊断信息。
 */
(() => {
  const FRAME_FLUSH_MS = 250;
  const FRAME_BATCH_MAX = 30;
  const POLL_OK_MS = 4000;
  const POLL_ERR_MS = 12000;

  let roomId = '';
  let paused = false;
  let queue = [];
  let flushTimer = null;
  let framesTotal = 0;
  let lastFrameAt = 0;
  let pollOk = null;
  let pollError = '';
  let pollTimer = null;
  let polling = false;
  let lastPollAt = 0;
  let alive = true;
  let tap = { on: false, reason: '', sampleRate: 0, pcmChunks: 0 };
  let rec = { on: false };
  let asrEnabled = null; // 房间是否开了 B 站 ASR；null = 还没拿到
  let manualLocal = false; // 用户手动开了本地识别
  let userStopped = false; // 用户手动关掉了本地识别（本页生效，刷新后重置）

  function parseRoomId() {
    const m = location.pathname.match(/\/(?:blanc\/)?(\d{1,12})(?:[/?#]|$)/);
    return m ? m[1] : '';
  }

  function send(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* 扩展被重载/卸载时忽略 */
    }
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!queue.length) return;
    const frames = queue;
    queue = [];
    send({
      type: 'frames',
      roomId,
      title: document.title,
      url: location.href,
      frames,
    });
    // 后台标签页的定时器会被浏览器节流，这里用「有弹幕帧」顺带驱动一次快照，
    // 避免只有前台标签页才能及时更新麦位。
    maybePoll();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FRAME_FLUSH_MS);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__biliRec !== 1) return;
    if (d.type === 'frame') {
      framesTotal += 1;
      lastFrameAt = d.recvAt || Date.now();
      if (paused) return;
      queue.push({ b64: d.b64, recvAt: d.recvAt || Date.now(), op: d.op, ver: d.ver, url: d.url });
      if (queue.length >= FRAME_BATCH_MAX) flush();
      else scheduleFlush();
    } else if (d.type === 'hooked') {
      send({ type: 'diag', roomId, hooked: true });
    } else if (d.type === 'seed') {
      send({ type: 'seed', roomId: (d.seed && d.seed.room && d.seed.room.roomId) || roomId, at: Date.now(), seed: d.seed });
      const flag = d.seed && d.seed.room ? d.seed.room.asrEnabled : null;
      if (typeof flag === 'boolean') applyAsrFlag(flag);
    } else if (d.type === 'pcm') {
      tap.pcmChunks += 1;
      send({ type: 'pcm', roomId, at: d.at || Date.now(), rate: d.rate || 16000, b64: d.b64 });
    } else if (d.type === 'audio-chunk') {
      send({ type: 'audio-chunk', roomId, recId: d.recId, seq: d.seq, at: d.at, mime: d.mime, b64: d.b64 });
    } else if (d.type === 'audio-stop') {
      send({ type: 'audio-stop', roomId, recId: d.recId, startedAt: d.startedAt, stoppedAt: d.stoppedAt, mime: d.mime, title: document.title });
    } else if (d.type === 'rec-status') {
      rec = {
        ...rec,
        on: !!d.on,
        recId: d.recId || rec.recId,
        startedAt: d.startedAt || rec.startedAt,
        mime: d.mime || rec.mime,
        chunks: d.chunks == null ? rec.chunks : d.chunks,
        reason: d.reason || '',
      };
      send({ type: 'rec-status', roomId, rec });
    } else if (d.type === 'tap-status') {
      tap = {
        ...tap,
        on: !!d.ok,
        reason: d.reason || '',
        sampleRate: d.sampleRate || tap.sampleRate,
        state: d.state || tap.state,
        sent: d.sent == null ? tap.sent : d.sent,
        error: d.error || '',
        media: d.media || tap.media,
      };
      send({ type: 'tap-status', roomId, tap });
    } else if (d.type === 'hook-stats') {
      send({ type: 'diag', roomId, hooked: true, hookFrames: d.frameCount });
    }
  });

  // ---- WBI / 房间快照 ----
  let wbiKeys = null;
  let wbiAt = 0;

  async function fetchJson(url) {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function getWbiKeys(force = false) {
    if (wbiKeys && !force && Date.now() - wbiAt < 2 * 3600 * 1000) return wbiKeys;
    const nav = await fetchJson('https://api.bilibili.com/x/web-interface/nav');
    const img = nav && nav.data && nav.data.wbi_img;
    if (!img || !img.img_url || !img.sub_url) throw new Error('拿不到 WBI key（可能未登录或接口风控）');
    const pick = (u) => String(u).split('/').pop().split('.')[0];
    wbiKeys = [pick(img.img_url), pick(img.sub_url)];
    wbiAt = Date.now();
    return wbiKeys;
  }

  async function pollSnapshot() {
    if (!alive || polling) return;
    polling = true;
    lastPollAt = Date.now();
    const rid = roomId || parseRoomId();
    if (!rid) {
      polling = false;
      schedulePoll(POLL_ERR_MS);
      return;
    }
    try {
      const { signParams } = globalThis.BiliWbi;
      let keys = await getWbiKeys();
      let qs = signParams({ room_id: rid }, keys[0], keys[1]);
      let json = await fetchJson(`https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?${qs}`);
      if (json.code === -352 || json.code === -403) {
        keys = await getWbiKeys(true);
        qs = signParams({ room_id: rid }, keys[0], keys[1]);
        json = await fetchJson(`https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?${qs}`);
      }
      if (json.code !== 0) throw new Error(`getInfoByRoom code=${json.code} ${json.message || ''}`);
      pollOk = true;
      pollError = '';
      send({ type: 'snapshot', roomId: rid, at: Date.now(), data: json.data });
      const flag = readAsrFlag(json.data);
      if (typeof flag === 'boolean') applyAsrFlag(flag);
      polling = false;
      schedulePoll(POLL_OK_MS);
    } catch (e) {
      pollOk = false;
      pollError = String((e && (e.stack || e.message)) || e || 'unknown') + (e && e.cause ? ` | cause=${e.cause}` : '');
      polling = false;
      schedulePoll(POLL_ERR_MS);
    }
  }

  function maybePoll() {
    if (polling) return;
    if (Date.now() - lastPollAt > POLL_OK_MS) pollSnapshot();
  }

  function schedulePoll(ms) {
    if (pollTimer) clearTimeout(pollTimer);
    const jitter = Math.floor(Math.random() * 800);
    pollTimer = setTimeout(pollSnapshot, ms + jitter);
  }

  // ---- 生命周期 ----
  function hello() {
    const rid = parseRoomId();
    if (!rid) return;
    roomId = rid;
    send({ type: 'hello', roomId: rid, title: document.title, url: location.href });
  }

  function watchUrl() {
    let lastRoom = parseRoomId();
    setInterval(() => {
      const now = parseRoomId();
      if (now && now !== lastRoom) {
        lastRoom = now;
        flush();
        hello();
        pollSnapshot();
      }
    }, 1500);
  }

  // ---- 本地识别：音频旁听开/关 ----
  let wantTap = false;

  function readAsrFlag(data) {
    if (!data) return null;
    const mv = data.multi_voice;
    if (mv && typeof mv.enable_asr === 'boolean') return mv.enable_asr;
    const ui = data.universal_interact_info_v2 || data.universal_interact_info || {};
    for (const m of ui.members || []) {
      const v = m && m.biz_extra_data && m.biz_extra_data.multi_voice;
      if (v && typeof v.enable_asr === 'boolean') return v.enable_asr;
    }
    return null;
  }

  /** B 站 ASR 开着就用 B 站的（更准、几乎不耗 CPU），关掉才旁听音频跑本地识别。 */
  function applyAsrFlag(flag) {
    if (asrEnabled === flag) {
      // 状态没变也顺手纠正一次（比如上次切换失败）
      if (flag === false && !wantTap && !userStopped) startTap();
      return;
    }
    asrEnabled = flag;
    send({ type: 'asr-flag', roomId, enabled: flag });
    if (flag === true) {
      manualLocal = false;
      if (wantTap) stopTap();
    } else if (flag === false && !userStopped) {
      startTap();
    }
  }

  function startTap() {
    wantTap = true;
    window.postMessage({ __biliRec: 1, type: 'tap-start' }, '*');
  }
  function stopTap() {
    wantTap = false;
    window.postMessage({ __biliRec: 1, type: 'tap-stop' }, '*');
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'pause') {
      paused = true;
      flush();
      if (wantTap) window.postMessage({ __biliRec: 1, type: 'tap-stop' }, '*');
      sendResponse({ ok: true, paused });
    } else if (msg.type === 'resume') {
      paused = false;
      if (wantTap) window.postMessage({ __biliRec: 1, type: 'tap-start' }, '*');
      sendResponse({ ok: true, paused });
    } else if (msg.type === 'local-asr-on') {
      manualLocal = true;
      userStopped = false;
      if (asrEnabled === true) {
        send({ type: 'tap-status', roomId, tap: { ...tap, on: false, reason: 'bili-asr-on' } });
        sendResponse({ ok: false, reason: 'bili-asr-on' });
      } else {
        startTap();
        sendResponse({ ok: true });
      }
    } else if (msg.type === 'local-asr-off') {
      manualLocal = false;
      userStopped = true;
      stopTap();
      sendResponse({ ok: true });
    } else if (msg.type === 'rec-start') {
      window.postMessage({ __biliRec: 1, type: 'rec-start' }, '*');
      sendResponse({ ok: true });
    } else if (msg.type === 'rec-stop') {
      window.postMessage({ __biliRec: 1, type: 'rec-stop' }, '*');
      sendResponse({ ok: true });
    } else if (msg.type === 'state') {
      sendResponse({
        ok: true,
        paused,
        roomId,
        framesTotal,
        lastFrameAt,
        pollOk,
        pollError,
        tap,
        rec,
        hooked: true,
      });
    } else if (msg.type === 'snapshot-now') {
      pollSnapshot();
      sendResponse({ ok: true });
    } else if (msg.type === 'ping') {
      sendResponse({ ok: true });
    }
    return true;
  });

  hello();
  watchUrl();
  schedulePoll(1200);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollSnapshot();
  });
  setInterval(() => {
    send({
      type: 'diag',
      roomId,
      framesTotal,
      lastFrameAt,
      pollOk,
      pollError,
      paused,
      tap,
    });
  }, 15000);
  window.addEventListener('beforeunload', () => {
    alive = false;
    flush();
    send({ type: 'tab-gone', roomId });
  });
})();



