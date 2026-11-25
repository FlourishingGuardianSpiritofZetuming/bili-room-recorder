// B站直播弹幕 WebSocket 探针：连接真实直播间，统计 cmd 类型并落盘样本。
// 用法: node probe.mjs <roomId> [seconds] [--out file.jsonl]
import { appendFileSync, mkdirSync } from 'node:fs';
import { brotliDecompressSync, inflateSync } from 'node:zlib';
import { dirname } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const args = process.argv.slice(2);
const roomId = Number(args[0] || 0);
const seconds = Number(args[1] || 60);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
if (!roomId) { console.error('usage: node probe.mjs <roomId> [seconds] [--out file.jsonl]'); process.exit(1); }

const jar = new Map();
function storeCookies(res) {
  for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const [pair] = c.split(';'); const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
async function get(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Referer: 'https://live.bilibili.com/', ...(opts.headers || {}) }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  storeCookies(res);
  return res;
}
await get('https://live.bilibili.com/');
try {
  const spi = await (await get('https://api.bilibili.com/x/frontend/finger/spi')).json();
  if (spi.code === 0) { jar.set('buvid3', spi.data.b_3); jar.set('buvid4', spi.data.b_4); }
} catch {}
const api = async (path) => {
  const j = await (await get(`https://api.live.bilibili.com${path}`, { headers: { Cookie: cookieHeader() } })).json();
  if (j.code !== 0) throw new Error(`${path} code=${j.code} msg=${j.message}`);
  return j.data;
};

function decodeFrame(buf) {
  const out = [];
  const walk = (b) => {
    let off = 0;
    while (off + 16 <= b.length) {
      const packetLen = b.readUInt32BE(off);
      const headerLen = b.readUInt16BE(off + 4);
      const ver = b.readUInt16BE(off + 6);
      const op = b.readUInt32BE(off + 8);
      if (packetLen < 16 || off + packetLen > b.length) break;
      const body = b.subarray(off + headerLen, off + packetLen);
      off += packetLen;
      if (op === 5) {
        if (ver === 2) walk(inflateSync(body));
        else if (ver === 3) walk(brotliDecompressSync(body));
        else if (body.length) out.push({ op, ver, json: JSON.parse(body.toString('utf8')) });
      } else if (op === 8) out.push({ op, ver, json: body.length ? JSON.parse(body.toString('utf8')) : null });
      else if (op === 3) out.push({ op, ver, popularity: body.readUInt32BE(0) });
    }
  };
  walk(buf);
  return out;
}
function buildPacket(op, bodyStr) {
  const body = Buffer.from(bodyStr, 'utf8');
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16 + body.length, 0);
  head.writeUInt16BE(16, 4);
  head.writeUInt16BE(1, 6);
  head.writeUInt32BE(op, 8);
  head.writeUInt32BE(1, 12);
  return Buffer.concat([head, body]);
}

const init = await api(`/room/v1/Room/room_init?id=${roomId}`);
const realId = init.room_id;
const conf = await api(`/room/v1/Danmu/getConf?room_id=${realId}&platform=pc&player=web`);
const hl = (conf.host_server_list && conf.host_server_list[0]) || null;
const server = hl ? { host: hl.host, port: hl.wss_port || 443 } : { host: conf.host, port: conf.port };
console.log(`room=${roomId} real=${realId} live=${init.live_status} server=${server.host}:${server.port} tokenLen=${String(conf.token || '').length}`);

const ws = new WebSocket(`wss://${server.host}:${server.port}/sub`);
const cmds = new Map(); const samples = new Map();
let msgCount = 0;
const done = new Promise((resolve) => {
  const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(); }, seconds * 1000);
  ws.addEventListener('close', () => { clearTimeout(timer); resolve(); });
});
ws.addEventListener('open', () => {
  console.log('ws open, auth...');
  const auth = { uid: 0, roomid: realId, protover: 3, platform: 'web', type: 2, key: conf.token, buvid: jar.get('buvid3') || '', clientver: '2.0.0', mobi_app: 'web' };
  ws.send(buildPacket(7, JSON.stringify(auth)));
  const hb = setInterval(() => { try { ws.send(buildPacket(2, '[object Object]')); } catch { clearInterval(hb); } }, 25000);
  ws.addEventListener('close', () => clearInterval(hb));
});
ws.addEventListener('message', async (ev) => {
  try {
    const buf = typeof ev.data === 'string' ? Buffer.from(ev.data, 'utf8') : Buffer.from(await new Response(ev.data).arrayBuffer());
    for (const m of decodeFrame(buf)) {
      if (!m.json) { if (m.op === 8) console.log('auth reply:', JSON.stringify(m.json)); continue; }
      msgCount++;
      const key = (m.json.cmd || `op${m.op}`).split(':')[0];
      cmds.set(key, (cmds.get(key) || 0) + 1);
      if (outFile) { mkdirSync(dirname(outFile), { recursive: true }); appendFileSync(outFile, JSON.stringify({ cmd: key, ts: Date.now(), json: m.json }) + '\n'); }
      if (!samples.has(key)) samples.set(key, m.json);
      if (key === 'DANMU_MSG') { const d = m.json.info; console.log(`DANMU uid=${d?.[2]?.[0]} uname=${d?.[2]?.[1]} text=${JSON.stringify(d?.[1])}`); }
    }
  } catch (e) { console.error('decode error', e.message); }
});
ws.addEventListener('error', (e) => console.error('ws error', e?.message || e?.type || 'unknown', e?.error?.message || ''));
await done;
await new Promise((r) => setTimeout(r, 300));
console.log(`\nmessages=${msgCount} cmdKinds=${cmds.size}`);
for (const [k, v] of [...cmds.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(5)}  ${k}`);
if (outFile) console.log(`samples -> ${outFile}`);
process.exit(0);

