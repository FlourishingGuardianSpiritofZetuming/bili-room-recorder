import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeDanmu,
  normalizeAsr,
  normalizeMessage,
  extractRoomMeta,
  extractSeats,
  diffSeats,
} from '../extension/src/common/normalize.js';

const fixture = readFileSync(new URL('./fixtures/room-A.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

const find = (cmd) => fixture.find((x) => x.cmd === cmd)?.json;

test('DANMU_MSG 归一化出 uid/昵称/正文', () => {
  const e = normalizeDanmu(find('DANMU_MSG'), 1700000000000);
  assert.ok(e);
  assert.equal(e.kind, 'danmu');
  assert.equal(typeof e.text, 'string');
  assert.ok(e.text.length > 0);
  assert.ok(e.id, '应有稳定 id 用于去重');
  assert.equal(e.t, 1700000000000);
});

test('DANMU_MSG 缺字段时返回 null 而不是抛错', () => {
  assert.equal(normalizeDanmu({}, 1), null);
  assert.equal(normalizeDanmu({ info: [] }, 1), null);
  assert.equal(normalizeDanmu({ info: [0, '   '] }, 1), null);
});

test('UNIVERSAL_ASR_TEXT 每句一个事件，带说话人与时长', () => {
  const json = find('UNIVERSAL_ASR_TEXT');
  const events = normalizeAsr(json, 1700000000000);
  assert.equal(events.length, json.data.sentences.length);
  for (const e of events) {
    assert.equal(e.kind, 'asr');
    assert.equal(e.uid, String(json.data.uid));
    assert.equal(e.name, json.data.uname);
    assert.ok(e.text.length > 0);
    assert.ok(e.dur >= 0);
  }
});

test('normalizeMessage 忽略未知 cmd', () => {
  assert.deepEqual(normalizeMessage({ cmd: 'SOMETHING_NEW', data: {} }, 1), []);
});

test('normalizeMessage 保留多语音房未公开事件（raw）', () => {
  const out = normalizeMessage({ cmd: 'UNIVERSAL_INTERACT_JOIN', data: { a: 1 } }, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'raw');
  assert.equal(out[0].cmd, 'UNIVERSAL_INTERACT_JOIN');
  assert.deepEqual(out[0].payload.data, { a: 1 });
});

test('extractRoomMeta / extractSeats / diffSeats 端到端', () => {
  const fake = {
    room_info: {
      room_id: 123,
      short_id: 0,
      title: '测试语聊房',
      anchor_name: 'x',
      area_name: '交友',
      parent_area_name: '聊天室',
      live_status: 1,
      online: 888,
      attention: 1000,
      live_start_time: '2026-01-01 00:00:00',
    },
    anchor_info: { base_info: { uid: 9, uname: '主播A' } },
    universal_interact_info_v2: {
      biz_session_id: 's1',
      business_label: 'multi_voice',
      members: [
        { uid: 1, uname: '甲', position: 0, join_time: 1700000000, biz_extra_data: { multi_voice: { is_mute: 0, role: 2 } } },
        { uid: 2, uname: '乙', position: 1, join_time: 1700000100, biz_extra_data: { multi_voice: { is_mute: 1, role: 1 } } },
      ],
    },
  };
  const meta = extractRoomMeta(fake);
  assert.equal(meta.title, '测试语聊房');
  assert.equal(meta.anchor, '主播A');
  assert.equal(meta.online, 888);

  const seats = extractSeats(fake);
  assert.equal(seats.length, 2);
  assert.equal(seats[0].position, 0);
  assert.equal(seats[0].joinTime, 1700000000000);
  assert.equal(seats[1].mute, true);

  // 甲下麦、乙开麦、丙上麦
  const next = extractSeats({
    universal_interact_info_v2: {
      members: [
        { uid: 2, uname: '乙', position: 1, join_time: 1700000100, biz_extra_data: { multi_voice: { is_mute: 0, role: 1 } } },
        { uid: 3, uname: '丙', position: 2, join_time: 1700000200, biz_extra_data: { multi_voice: { is_mute: 0, role: 1 } } },
      ],
    },
  });
  const events = diffSeats(seats, next, 1700000300000);
  const actions = events.map((e) => `${e.action}:${e.name}`).sort();
  assert.deepEqual(actions, ['join:丙', 'leave:甲', 'unmute:乙']);
  const join = events.find((e) => e.action === 'join');
  assert.equal(join.t, 1700000200000, '上麦时间应使用服务端 join_time');
  assert.equal(join.detectedAt, 1700000300000);
});

test('单人连麦房 voice_join_info 也能解析成座位', () => {
  const seats = extractSeats({
    voice_join_info: { status: { uid: 77, user_name: '单麦用户', status: 1, start_at: 1700000000 } },
  });
  assert.equal(seats.length, 1);
  assert.equal(seats[0].uid, '77');
  assert.equal(seats[0].single, true);
});

