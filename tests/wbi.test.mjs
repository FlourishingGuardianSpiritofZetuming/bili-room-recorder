import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const src = readFileSync(new URL('../extension/src/common/wbi.js', import.meta.url), 'utf8');
vm.runInThisContext(src);
const WBI = globalThis.BiliWbi;

test('MD5 标准测试向量', () => {
  assert.equal(WBI.md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(WBI.md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(WBI.md5('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
});

test('MD5 与 Node crypto 对中文/长文本一致', () => {
  const samples = ['中文测试', 'a'.repeat(1000), '😀 emoji 混排', '国'.repeat(13)];
  for (const s of samples) {
    assert.equal(WBI.md5(s), createHash('md5').update(s, 'utf8').digest('hex'), s.slice(0, 10));
  }
});

test('mixinKey 长度为 32', () => {
  const key = WBI.mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
  assert.equal(key.length, 32);
});

test('signParams 生成 wts + w_rid，且 w_rid 可独立复算', () => {
  const imgKey = '7cd084941338484aae1ad9425b84077c';
  const subKey = '4932caff0ff746eab6f01bf08b70ac45';
  const qs = WBI.signParams({ room_id: 12345678, foo: 'a b' }, imgKey, subKey, 1700000000);
  assert.match(qs, /wts=1700000000/);
  const m = qs.match(/w_rid=([0-9a-f]{32})/);
  assert.ok(m, '应有 w_rid');
  const query = qs.replace(/&w_rid=[0-9a-f]{32}$/, '');
  const expect = createHash('md5').update(query + WBI.mixinKey(imgKey, subKey), 'utf8').digest('hex');
  assert.equal(m[1], expect);
  // 参数按字典序拼接
  assert.ok(qs.indexOf('foo=') < qs.indexOf('room_id='));
});

test('extractWbiKeys 从 nav 响应里取 key', () => {
  const keys = WBI.extractWbiKeys({
    data: {
      wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
      },
    },
  });
  assert.deepEqual(keys, ['7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45']);
});

