import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, deflateSync } from 'node:zlib';
import { splitPackets, decodeFrame, buildPacket } from '../extension/src/common/protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'room-A.jsonl');

const brotli = (b) => new Uint8Array(brotliDecompressSync(Buffer.from(b)));

function packetize(ver, op, payload) {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16 + payload.length, 0);
  header.writeUInt16BE(16, 4);
  header.writeUInt16BE(ver, 6);
  header.writeUInt32BE(op, 8);
  header.writeUInt32BE(1, 12);
  return new Uint8Array(Buffer.concat([header, payload]));
}

test('splitPackets 能切出包头字段', () => {
  const pkt = buildPacket(5, JSON.stringify({ cmd: 'X', data: 1 }), { ver: 0 });
  const parts = splitPackets(pkt);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].ver, 0);
  assert.equal(parts[0].op, 5);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(parts[0].body)), { cmd: 'X', data: 1 });
});

test('ver=0 明文包直接解出 JSON，且不碰 brotli', async () => {
  const pkt = buildPacket(5, JSON.stringify({ cmd: 'DANMU_MSG', info: [1, 'hi'] }), { ver: 0 });
  const out = await decodeFrame(pkt, () => {
    throw new Error('不应调用 brotli');
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].json.cmd, 'DANMU_MSG');
});

test('ver=3 brotli 包能解压真实 ASR 样本', async () => {
  const lines = readFileSync(fixture, 'utf8').trim().split('\n');
  const asr = JSON.parse(lines.find((l) => l.includes('UNIVERSAL_ASR_TEXT'))).json;
  // 真实链路里 brotli 解出来的内容是「带 16 字节头的包流」
  const inner = buildPacket(5, JSON.stringify(asr), { ver: 0 });
  const compressed = brotliCompressSync(Buffer.from(inner));
  const out = await decodeFrame(packetize(3, 5, compressed), brotli);
  assert.equal(out.length, 1);
  assert.equal(out[0].json.cmd, 'UNIVERSAL_ASR_TEXT');
  assert.ok(out[0].json.data.sentences.length >= 1);
});

test('ver=2 zlib 包走 DecompressionStream（浏览器同款实现）', async () => {
  const inner = buildPacket(5, JSON.stringify({ cmd: 'DANMU_MSG', info: [1, 'zlib'] }), { ver: 0 });
  const compressed = deflateSync(Buffer.from(inner));
  const out = await decodeFrame(packetize(2, 5, compressed), () => {
    throw new Error('不应走 brotli');
  });
  assert.equal(out[0].json.info[1], 'zlib');
});

test('嵌套包（brotli 里再套多个明文包）能递归解析', async () => {
  const inner = Buffer.concat([
    Buffer.from(buildPacket(5, JSON.stringify({ cmd: 'A' }), { ver: 0 })),
    Buffer.from(buildPacket(5, JSON.stringify({ cmd: 'B' }), { ver: 0 })),
  ]);
  const compressed = brotliCompressSync(inner);
  const out = await decodeFrame(packetize(3, 5, compressed), brotli);
  assert.deepEqual(out.map((o) => o.json.cmd), ['A', 'B']);
});

test('心跳回复 op=3 解析为人气值', async () => {
  const body = Buffer.alloc(4);
  body.writeUInt32BE(12345, 0);
  const out = await decodeFrame(packetize(1, 3, body), brotli);
  assert.equal(out[0].popularity, 12345);
});

test('损坏/截断的包不会抛异常', async () => {
  const ok = buildPacket(5, JSON.stringify({ cmd: 'A' }), { ver: 0 });
  const truncated = ok.subarray(0, 10);
  const out = await decodeFrame(truncated, brotli);
  assert.equal(out.length, 0);
});

test('vendor 的 brotli-dec-wasm 能正确解压（浏览器里走的就是它）', async () => {
  const wasmPath = join(here, '..', 'extension', 'vendor', 'brotli_dec_wasm_bg.wasm');
  const gluePath = join(here, '..', 'extension', 'vendor', 'brotli_dec_wasm.js');
  const bytes = readFileSync(wasmPath);
  const glue = await import(`file://${gluePath.replace(/\\/g, '/')}`);
  const module = await WebAssembly.compile(bytes);
  glue.initSync({ module });
  const samples = [
    'hello',
    '{"cmd":"UNIVERSAL_ASR_TEXT","data":{"text":"中文测试"}}',
    'x'.repeat(20000),
  ];
  for (const s of samples) {
    const comp = brotliCompressSync(Buffer.from(s));
    const plain = glue.decompress(new Uint8Array(comp));
    assert.equal(Buffer.from(plain).toString('utf8'), s);
  }
});
