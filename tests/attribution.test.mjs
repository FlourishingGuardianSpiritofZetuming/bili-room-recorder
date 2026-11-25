import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpeaker } from '../extension/src/common/attribution.js';

const seat = (uid, name, mute, position = 0) => ({ uid: String(uid), name, mute, position });

test('只有一个人开麦时精确归属', () => {
  const sp = resolveSpeaker([seat(1, '甲', false), seat(2, '乙', true), seat(3, '丙', true)]);
  assert.equal(sp.name, '甲');
  assert.equal(sp.uid, '1');
  assert.equal(sp.confidence, 'single');
});

test('多人开麦时不瞎猜，标“麦上多人”并给出候选', () => {
  const sp = resolveSpeaker([seat(1, '甲', false), seat(2, '乙', false), seat(3, '丙', true)]);
  assert.equal(sp.name, '麦上多人（2）');
  assert.equal(sp.uid, '');
  assert.deepEqual(sp.candidates, ['甲', '乙']);
  assert.equal(sp.confidence, 'multi');
});

test('全部闭麦时明确标注', () => {
  const sp = resolveSpeaker([seat(1, '甲', true), seat(2, '乙', true)]);
  assert.equal(sp.name, '麦上（全部闭麦）');
  assert.equal(sp.confidence, 'none');
});

test('没有麦位数据时不崩溃', () => {
  assert.equal(resolveSpeaker([]).name, '麦上（全部闭麦）');
  assert.equal(resolveSpeaker(null).name, '麦上（全部闭麦）');
});

test('单人连麦房（只有一条座位）直接归属', () => {
  const sp = resolveSpeaker([{ uid: '9', name: '单麦用户', mute: false, position: 0, single: true }]);
  assert.equal(sp.name, '单麦用户');
  assert.equal(sp.confidence, 'single');
});

test('缺名字时退回 UID', () => {
  const sp = resolveSpeaker([{ uid: '42', name: '', mute: false, position: 1 }]);
  assert.equal(sp.name, 'UID 42');
});
