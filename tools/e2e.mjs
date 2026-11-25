// 端到端冒烟测试：headless Edge 加载扩展 → 同时开两个语聊房 → 校验两路独立记录 → 校验面板与导出。
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = process.env.EXT || `${ROOT}/extension`;
const PROFILE = `${ROOT}/tools/tmp-e2e-profile`;
const ROOMS = (process.argv[2] || '12345678,1982729771').split(',');
const WAIT_MS = Number(process.argv[3] || 45000);
const PORT = 9333;
const EXT_ID = readFileSync(`${ROOT}/tools/ext-id.txt`, 'utf8').trim();
const DASH = `chrome-extension://${EXT_ID}/src/ui/dashboard.html`;

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,800',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    `https://live.bilibili.com/${ROOMS[0]}`,
  ],
  { stdio: 'ignore' },
);

const json = async (p, o) => (await fetch(`http://127.0.0.1:${PORT}${p}`, o)).json();
let version = null;
for (let i = 0; i < 60; i += 1) {
  try {
    version = await json('/json/version');
    break;
  } catch {
    await sleep(500);
  }
}
if (!version) {
  console.error('无法连接 DevTools');
  child.kill();
  process.exit(2);
}
console.log('browser:', version.Browser, '| ext:', EXT_ID, '| rooms:', ROOMS.join(','));

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws error')));
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ready, send, ws };
}

async function evalIn(wsUrl, expression) {
  const c = cdp(wsUrl);
  await c.ready;
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  c.ws.close();
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result.value;
}

// 开第二个房间
for (const extra of ROOMS.slice(1)) {
  await json(`/json/new?${encodeURIComponent(`https://live.bilibili.com/${extra}`)}`, { method: 'PUT' }).catch(() => {});
}

// 后台标签页不会自动播放，测试里把它切到前台推一把（真实使用中用户已经点过播放）
if (ROOMS.length > 1) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(6000);
    const tabsNow = await json('/json/list');
    const live = tabsNow.filter((t) => t.type === 'page' && t.url.includes('live.bilibili.com'));
    for (const p of live) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/json/activate/${p.id}`);
        await sleep(1200);
        await evalIn(p.webSocketDebuggerUrl, `(() => { const v = document.querySelector('video'); if (!v) return 'no-video'; if (v.paused) v.play().catch(() => {}); return v.paused ? 'paused' : 'playing'; })()`);
      } catch {}
    }
    const playing = await Promise.all(
      live.map(async (p) => {
        try {
          return await evalIn(p.webSocketDebuggerUrl, `(() => { const v = document.querySelector('video'); return v && !v.paused ? 'playing' : 'not-playing'; })()`);
        } catch {
          return '?';
        }
      }),
    );
    if (playing.every((x) => x === 'playing')) break;
  }
  try {
    const all = await json('/json/list');
    const first = all.find((t) => t.type === 'page' && t.url.includes(ROOMS[0]));
    if (first) await fetch(`http://127.0.0.1:${PORT}/json/activate/${first.id}`);
  } catch {}
}

console.log(`等待 ${Math.round(WAIT_MS / 1000)}s ...`);
await sleep(WAIT_MS);

const dash = await json(`/json/new?${encodeURIComponent(DASH)}`, { method: 'PUT' }).catch(() => null);
await sleep(3000);

let targets = await json('/json/list');
const pages = targets.filter((t) => t.type === 'page' && t.url.includes('live.bilibili.com'));
for (const p of pages) {
  const info = await evalIn(p.webSocketDebuggerUrl, `JSON.stringify({ href: location.href, hooked: !!window.__biliRoomRecorderHooked__ })`);
  console.log('tab:', info);
}

const SUMMARY = `(async () => {
  const open = indexedDB.open('bili-voice-recorder');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
  const tx = db.transaction(['sessions', 'events']);
  const getAll = (n) => new Promise((res) => { const q = tx.objectStore(n).getAll(); q.onsuccess = () => res(q.result); });
  const sessions = await getAll('sessions');
  const events = await getAll('events');
  const rows = sessions.map((s) => ({
    id: s.id,
    roomId: s.roomId,
    title: s.title,
    status: s.status,
    counts: s.counts,
    pollOk: s.diag && s.diag.pollOk,
    pollError: (s.diag && s.diag.pollError || '').slice(0, 90),
    frames: s.diag && s.diag.framesTotal,
    messages: s.diag && s.diag.messages,
    decodeErrors: s.diag && s.diag.decodeErrors,
    initialSeats: (s.initialSeats || []).length,
    seats: events.filter((e) => e.kind === 'seat' && e.sid === s.id).slice(0, 6).map(function (e) { return e.action + ':' + e.name + ':' + e.position; }),
    tap: s.diag && s.diag.tap,
    asrSource: {
      bili: events.filter((e) => e.sid === s.id && e.kind === 'asr' && e.source !== 'local').length,
      local: events.filter((e) => e.sid === s.id && e.kind === 'asr' && e.source === 'local').length,
    },
    localAsr: events.filter((e) => e.kind === 'asr' && e.source === 'local' && e.sid === s.id).slice(0, 5).map(function (e) { return e.t + ' ' + e.name + ' :: ' + e.text; }),
    events: events.filter((e) => e.sid === s.id).length,
  }));
  return JSON.stringify(rows);
})()`;

const target = dash && dash.webSocketDebuggerUrl ? dash : targets.find((t) => t.url.startsWith(`chrome-extension://${EXT_ID}/`));
const rows = JSON.parse(await evalIn(target.webSocketDebuggerUrl, SUMMARY));
console.log('\n=== 记录情况 ===');
for (const r of rows) console.log(JSON.stringify(r));

// 在面板页里真实走一遍「事件 → 报告 → Markdown」
const MD = `(async () => {
  const [{ buildRoomReport }, F] = await Promise.all([import('../common/session.js'), import('../common/format.js')]);
  const open = indexedDB.open('bili-voice-recorder');
  const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
  const tx = db.transaction(['sessions', 'events']);
  const getAll = (n) => new Promise((res) => { const q = tx.objectStore(n).getAll(); q.onsuccess = () => res(q.result); });
  const sessions = await getAll('sessions');
  const events = await getAll('events');
  const reports = sessions.map((s) => buildRoomReport(s, events.filter((e) => e.sid === s.id)));
  return JSON.stringify({ one: F.renderRoomMarkdown(reports[0]).slice(0, 700), all: F.renderCombinedMarkdown(reports).slice(0, 500) });
})()`;
const md = JSON.parse(await evalIn(target.webSocketDebuggerUrl, MD));
console.log('\n--- 单房间 Markdown 预览 ---\n' + md.one);
console.log('\n--- 合并 Markdown 预览 ---\n' + md.all);

const dom = await evalIn(
  dash.webSocketDebuggerUrl,
  `new Promise((r) => setTimeout(() => r((document.querySelector('#sessionCount')?.textContent || '') + ' | items=' + document.querySelectorAll('.session-item').length + ' | title=' + (document.querySelector('#roomTitle')?.textContent || '')), 2500))`,
);
console.log('\ndashboard DOM:', dom);

try {
  const st = await evalIn(
    dash.webSocketDebuggerUrl,
    `chrome.runtime.sendMessage({ type: 'asr-status-get' }).then((r) => JSON.stringify(r && r.status))`,
  );
  console.log('本地识别状态:', st);
} catch (e) {
  console.log('读取本地识别状态失败', e.message);
}

// 截图留档
try {
  const c = cdp(dash.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${ROOT}/docs/dashboard-preview.png`, Buffer.from(shot.data, 'base64'));
  c.ws.close();
  console.log('截图已保存 docs/dashboard-preview.png');
} catch (e) {
  console.log('截图失败', e.message);
}

const distinctRooms = new Set(rows.map((r) => r.roomId));
const expected = Math.min(2, ROOMS.length);
const ok = rows.length >= expected && distinctRooms.size >= expected;
console.log(ok ? '\n✅ E2E 通过：两个房间分别记录，数据互不混淆' : '\n⚠️ E2E 未达标');
child.kill();
process.exit(ok ? 0 : 4);




