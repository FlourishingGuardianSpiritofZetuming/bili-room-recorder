// 用纯示例数据生成界面截图（避免公开真实房间/用户信息）
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = `${ROOT}/tools/tmp-demo-profile`;
const PORT = 9466;
const EXT_ID = readFileSync(`${ROOT}/tools/ext-id.txt`, 'utf8').trim();
const DASH = `chrome-extension://${EXT_ID}/src/ui/dashboard.html`;

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`, `--disable-extensions-except=${ROOT}/extension`,
  `--load-extension=${ROOT}/extension`, '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' });

const json = async (p, o) => (await fetch(`http://127.0.0.1:${PORT}${p}`, o)).json();
for (let i = 0; i < 60; i += 1) { try { await json('/json/version'); break; } catch { await sleep(500); } }

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
  return { ready, send, ws };
}
async function evalIn(wsUrl, expression) {
  const c = cdp(wsUrl); await c.ready;
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  c.ws.close();
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result.value;
}

// 等扩展 Service Worker 起来，再打开面板，避免扩展页面还没注册就导航
let ready = false;
for (let i = 0; i < 40; i += 1) {
  const ts = await json('/json/list');
  if (ts.some((t) => t.url.startsWith(`chrome-extension://${EXT_ID}/`))) { ready = true; break; }
  await sleep(500);
}
if (!ready) { console.error('extension not loaded'); child.kill(); process.exit(3); }
const dashTarget = await json(`/json/new?${encodeURIComponent(DASH)}`, { method: 'PUT' });
await sleep(2500);
const targets = await json('/json/list');
const dash = targets.find((t) => t.url.includes('dashboard.html'));
if (!dash) { console.error('no dashboard'); child.kill(); process.exit(2); }

const SEED = `(async () => {
  const db = await new Promise((res, rej) => {
    const req = indexedDB.open('bili-voice-recorder', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('events')) {
        const st = d.createObjectStore('events', { keyPath: 'pk' });
        st.createIndex('sid', 'sid');
        st.createIndex('sid_seq', ['sid', 'seq']);
      }
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const now = Date.now();
  const start = now - 28 * 60 * 1000;
  const sid = 'demo-room-1';
  const sessions = [{
    id: sid, tabId: 1, roomId: '12345678', title: '示例语聊房', anchor: '示例主播',
    url: 'https://live.bilibili.com/12345678',
    meta: { roomId: '12345678', title: '示例语聊房', anchor: '示例主播', area: '交友', parentArea: '聊天室', online: 3280 },
    startedAt: start, endedAt: 0, lastEventAt: now - 3000,
    counts: { asr: 9, danmu: 4, gift: 0, sc: 0, seat: 2, stat: 6, raw: 0 },
    diag: { lastFrameAt: now - 3000, framesTotal: 186, messages: 174, decodeErrors: 0, pollOk: true, pollError: '', paused: false, tap: { on: false }, rec: { on: false } },
    initialSeats: [{ uid: '1', name: '示例主播', position: 0 }, { uid: '2', name: '示例用户A', position: 1 }],
    asrEnabled: true,
    recordings: [{ filename: '语聊房录音_示例语聊房_12345678_20260101-120000.webm', size: 18632000, mime: 'audio/webm', startedAt: start, stoppedAt: start + 3600000, durationMs: 3600000, savedAt: now - 600000 }],
    status: 'recording',
  }, {
    id: 'demo-room-2', tabId: 2, roomId: '87654321', title: '示例语聊房B', anchor: '示例主播B',
    url: 'https://live.bilibili.com/87654321',
    meta: { roomId: '87654321', title: '示例语聊房B', anchor: '示例主播B', area: '交友', parentArea: '聊天室' },
    startedAt: start, endedAt: start + 1200000, lastEventAt: start + 1200000,
    counts: { asr: 0, danmu: 1, gift: 0, sc: 0, seat: 0, stat: 2, raw: 0 },
    diag: { pollOk: true }, initialSeats: [], asrEnabled: false, recordings: [], status: 'ended',
  }];
  const events = [];
  let seq = 0;
  const add = (e) => { seq += 1; events.push({ ...e, sid, seq, pk: sid + '|' + String(seq).padStart(10, '0') }); };
  const utt = [
    [1, '示例用户A', '今天人好多啊，欢迎新来的朋友。', 8000, 3200],
    [2, '示例用户B', '刚才那首歌叫什么名字？', 16000, 2600],
    [1, '示例用户A', '是《示例歌曲》，等会儿再放一遍。', 21500, 3900],
    [3, '示例用户C', '我先闭麦听一会儿。', 31000, 2000],
    [1, '示例用户A', '好，那我们继续聊刚才的话题。', 42000, 3300],
    [2, '示例用户B', '可以，我这边没问题。', 52000, 1800],
    [1, '示例用户A', '下一轮上麦的朋友准备一下。', 68000, 2800],
    [4, '示例用户D', '我准备好了。', 76000, 1200],
    [1, '示例用户A', '好，三、二、一，开始。', 86000, 2100],
  ];
  for (const [uid, name, text, offset, dur] of utt) add({ kind: 'asr', t: start + offset + dur, dur, uid: String(uid), name, text });
  add({ kind: 'danmu', t: start + 9000, uid: '11', name: '示例观众1', text: '前排打卡' });
  add({ kind: 'danmu', t: start + 33000, uid: '12', name: '示例观众2', text: '这个声音好好听' });
  add({ kind: 'danmu', t: start + 61000, uid: '13', name: '示例观众3', text: '哈哈哈' });
  add({ kind: 'danmu', t: start + 90000, uid: '14', name: '示例观众4', text: '主播加油' });
  add({ kind: 'seat', action: 'join', t: start + 20000, uid: '4', name: '示例用户D', position: 3, source: 'join_time' });
  add({ kind: 'seat', action: 'leave', t: start + 95000, uid: '4', name: '示例用户D', position: 3, source: 'snapshot' });
  add({ kind: 'stat', t: start + 5000, popularity: 3200, online: 28 });
  add({ kind: 'stat', t: start + 45000, popularity: 3280, online: 31 });
  add({ kind: 'stat', t: start + 90000, popularity: 3310, online: 27 });

  await new Promise((res, rej) => {
    const t = db.transaction(['sessions', 'events'], 'readwrite');
    t.objectStore('sessions').clear();
    t.objectStore('events').clear();
    for (const s of sessions) t.objectStore('sessions').put(s);
    for (const e of events) t.objectStore('events').put(e);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
  return 'seeded ' + events.length;
})()`;

console.log(await evalIn(dash.webSocketDebuggerUrl, SEED));
await sleep(800);

const shot = async (file, clickTab) => {
  const c = cdp(dash.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  if (clickTab) {
    await c.send('Runtime.evaluate', { expression: `document.querySelector('[data-tab="${clickTab}"]').click()`, returnByValue: true });
    await sleep(900);
  }
  const png = await c.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(png.data, 'base64'));
  c.ws.close();
};

await evalIn(dash.webSocketDebuggerUrl, `location.reload()`).catch(() => {});
await sleep(3000);
const dash2 = (await json('/json/list')).find((t) => t.url.includes('dashboard.html'));
await shot(`${ROOT}/docs/dashboard-preview.png`, null);
await shot(`${ROOT}/docs/recording-preview.png`, 'rec');
console.log('screenshots updated');
child.kill();
process.exit(0);


