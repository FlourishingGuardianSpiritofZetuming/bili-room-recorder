import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupUtterances, pairSeats, buildRoomReport } from '../extension/src/common/session.js';

const asr = (uid, name, text, t, dur = 1000) => ({ kind: 'asr', uid: String(uid), name, text, t, dur });

test('同一人连续短句合并成一段发言', () => {
  const events = [
    asr(1, '甲', '今天', 1000, 500),
    asr(1, '甲', '天气不错', 3000, 800),
    asr(2, '乙', '确实', 4000, 300),
    asr(1, '甲', '我们出去玩吧', 8000, 600),
  ];
  const utts = groupUtterances(events, 2500);
  assert.equal(utts.length, 3);
  assert.equal(utts[0].text, '今天，天气不错');
  assert.equal(utts[0].durMs, 1300);
  assert.equal(utts[0].start, 500, '开始时间按 收到时间-时长 估算');
  assert.equal(utts[0].end, 3000);
});

test('已带标点的句子不重复加逗号', () => {
  const utts = groupUtterances([asr(1, '甲', '你好。', 1000), asr(1, '甲', '再见', 2000)], 5000);
  assert.equal(utts[0].text, '你好。再见');
});

test('上下麦配对算出在麦时长', () => {
  const events = [
    { kind: 'seat', action: 'join', uid: '1', name: '甲', position: 0, t: 1000, source: 'join_time' },
    { kind: 'seat', action: 'join', uid: '2', name: '乙', position: 1, t: 2000, source: 'snapshot' },
    { kind: 'seat', action: 'leave', uid: '1', name: '甲', position: 0, t: 61000, source: 'snapshot' },
  ];
  const rows = pairSeats(events);
  const jia = rows.find((r) => r.name === '甲');
  assert.equal(jia.type, 'span');
  assert.equal(jia.endAt - jia.startAt, 60000);
  const yi = rows.find((r) => r.name === '乙');
  assert.equal(yi.type, 'open');
});

test('只看到下麦也能记录一行', () => {
  const rows = pairSeats([{ kind: 'seat', action: 'leave', uid: '9', name: '丙', position: 3, t: 5000 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'leave');
});

test('buildRoomReport 汇总说话人、弹幕、在线峰值', () => {
  const events = [
    asr(1, '甲', '第一句', 1000, 500),
    asr(1, '甲', '第二句', 2000, 500),
    asr(2, '乙', '第三句', 3000, 500),
    { kind: 'danmu', uid: '3', name: '观众', text: '666', t: 2500 },
    { kind: 'stat', online: 100, t: 900 },
    { kind: 'stat', online: 250, t: 3500 },
    { kind: 'seat', action: 'join', uid: '1', name: '甲', position: 0, t: 500, source: 'join_time' },
  ];
  const report = buildRoomReport({ id: 's', roomId: '42', startedAt: 0, meta: {} }, events);
  assert.equal(report.speakers.length, 2);
  assert.equal(report.speakers[0].count, 2);
  assert.equal(report.counts.danmu, 1);
  assert.equal(report.onlineMax, 250);
  assert.equal(report.seats.length, 1);
  assert.equal(report.seats[0].type, 'open');
  assert.equal(report.endedAt, 3500);
});
