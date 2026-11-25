// 录音功能冒烟测试：开录音 25 秒 → 停止 → 检查是否落盘/下载
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EXT = process.env.EXT || `${ROOT}/extension`;
const PROFILE = `${ROOT}/tools/tmp-rec-profile`;
const ROOM = process.argv[2] || '12345678';
const PORT = 9366;
const EXT_ID = readFileSync(`${ROOT}/tools/ext-id.txt`, 'utf8').trim();
const DASH = `chrome-extension://${EXT_ID}/src/ui/dashboard.html`;

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800',
  '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  `https://live.bilibili.com/${ROOM}`,
], { stdio: 'ignore' });

const json = async (p, o) => (await fetch(`http://127.0.0.1:${PORT}${p}`, o)).json();
for (let i = 0; i < 60; i += 1) { try { await json('/json/version'); break; } catch { await sleep(500); } }

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws error'))); });
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

console.log('等待页面播放...');
await sleep(15000);

const dash = await json(`/json/new?${encodeURIComponent(DASH)}`, { method: 'PUT' }).catch(() => null);
await sleep(2500);
const targets = await json('/json/list');
const dashTarget = (dash && dash.webSocketDebuggerUrl) ? dash : targets.find((t) => t.url.startsWith(`chrome-extension://${EXT_ID}/`));
if (!dashTarget) { console.error('no dashboard target'); child.kill(); process.exit(2); }

const tabId = await evalIn(dashTarget.webSocketDebuggerUrl, `(async () => { const t = await chrome.tabs.query({ url: 'https://live.bilibili.com/*' }); return t[0] ? t[0].id : 0; })()`);
console.log('room tabId =', tabId);

const startResp = await evalIn(dashTarget.webSocketDebuggerUrl, `(async () => { return JSON.stringify(await chrome.tabs.sendMessage(${tabId}, { type: 'rec-start' })); })()`);
console.log('rec-start =>', startResp);
await sleep(3000);
console.log('state after start:', await evalIn(dashTarget.webSocketDebuggerUrl, `(async () => JSON.stringify((await chrome.tabs.sendMessage(${tabId}, { type: 'state' })).rec))()`));

console.log('录 25 秒...');
await sleep(25000);

const stopResp = await evalIn(dashTarget.webSocketDebuggerUrl, `(async () => { return JSON.stringify(await chrome.tabs.sendMessage(${tabId}, { type: 'rec-stop' })); })()`);
console.log('rec-stop =>', stopResp);
await sleep(8000);

const summary = await evalIn(dashTarget.webSocketDebuggerUrl, `(async () => {
  const open = indexedDB.open('bili-voice-recorder');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
  const tx = db.transaction(['sessions']);
  const sessions = await new Promise((res) => { const q = tx.objectStore('sessions').getAll(); q.onsuccess = () => res(q.result); });
  const downloads = await chrome.downloads.search({ limit: 5, orderBy: ['-startTime'] });
  return JSON.stringify({
    recordings: sessions.flatMap((s) => (s.recordings || []).map((r) => ({ room: s.roomId, file: r.filename, size: r.size, dur: r.durationMs, dl: r.downloadId, head: r.head, parts: r.partsCount, offHeads: r.heads, bridgeHeads: s.diag && s.diag.audioHeads }))),
    downloads: downloads.map((d) => ({ filename: d.filename, bytes: d.bytesReceived, state: d.state, error: d.error })),
  });
})()`);
console.log('=== 结果 ===');
console.log(summary);
try {
  const c = cdp(dashTarget.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.evaluate', { expression: "document.querySelector('[data-tab=\"rec\"]').click()", returnByValue: true });
  await sleep(1200);
  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${ROOT}/docs/recording-preview.png`, Buffer.from(shot.data, 'base64'));
  c.ws.close();
  console.log('截图已保存 docs/recording-preview.png');
} catch (e) { console.log('截图失败', e.message); }
child.kill();
process.exit(0);



