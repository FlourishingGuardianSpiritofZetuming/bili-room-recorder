import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeMessage } from '../extension/src/common/normalize.js';
import { buildRoomReport } from '../extension/src/common/session.js';
import {
  renderRoomMarkdown,
  renderCombinedMarkdown,
  renderCompactText,
  toJsonl,
  fmtDuration,
  fmtClock,
  buildFileStem,
} from '../extension/src/common/format.js';

const lines = readFileSync(new URL('./fixtures/room-A.jsonl', import.meta.url), 'utf8').trim().split('\n');

function buildFixtureReport() {
  const events = [];
  let seq = 0;
  for (const line of lines) {
    const o = JSON.parse(line);
    const t = o.ts;
    for (const e of normalizeMessage(o.json, t)) {
      e.seq = ++seq;
      events.push(e);
    }
  }
  const session = {
    id: 'x',
    roomId: '12345678',
    title: '测试房间',
    url: 'https://live.bilibili.com/12345678',
    startedAt: 1795432500000,
    endedAt: 1795432600000,
    meta: { title: '测试房间', anchor: '主播', area: '交友', parentArea: '聊天室' },
  };
  return { events, report: buildRoomReport(session, events) };
}

test('fmtDuration / fmtClock 基本行为', () => {
  assert.equal(fmtDuration(3200), '3.2 秒');
  assert.equal(fmtDuration(61000), '1 分 01 秒');
  assert.equal(fmtDuration(3700000), '1 小时 1 分');
  assert.match(fmtClock(1795432500000), /^\d{2}:\d{2}:\d{2}$/);
});

test('单房间 Markdown 含六个小节和真实发言', () => {
  const { report } = buildFixtureReport();
  const md = renderRoomMarkdown(report);
  assert.match(md, /# 语聊房记录 · 测试房间/);
  assert.match(md, /## 一、发言时间线/);
  assert.match(md, /## 二、按说话人汇总/);
  assert.match(md, /## 三、上麦 \/ 下麦/);
  assert.match(md, /## 四、弹幕/);
  assert.match(md, /12345678/);
  assert.ok(report.utterances.length > 0, '样本里应有语音转写');
  assert.ok(md.includes(report.utterances[0].name));
  assert.ok(md.includes('| # | 时间 | 说话人 | 内容 | 时长 |'));
});

test('合并 Markdown 含房间清单与合并时间线', () => {
  const { report } = buildFixtureReport();
  const second = { ...report, session: { ...report.session, id: 'y', roomId: '999', title: '第二间' }, meta: { ...report.meta, title: '第二间' } };
  const md = renderCombinedMarkdown([report, second]);
  assert.match(md, /# 多语聊房合并记录/);
  assert.match(md, /## 房间清单/);
  assert.match(md, /## 合并时间线/);
  assert.match(md, /## 各房间明细/);
  assert.match(md, /第二间/);
});

test('表格单元格里的竖线和换行被转义', () => {
  const { report } = buildFixtureReport();
  report.danmu.push({ kind: 'danmu', t: report.startedAt, name: 'A|B', text: '第一行\n第二行|竖线' });
  const md = renderRoomMarkdown(report);
  assert.ok(md.includes('A\\|B'));
  assert.ok(md.includes('第一行<br>第二行\\|竖线'));
});

test('纯文本版按时间排序且包含说话人', () => {
  const { report } = buildFixtureReport();
  const txt = renderCompactText(report);
  assert.ok(txt.includes(report.utterances[0].name));
  const times = txt.split('\n').filter((l) => /^\[\d{2}:\d{2}:\d{2}\]/.test(l)).map((l) => l.slice(0, 10));
  assert.ok(times.length > 0);
  const sorted = [...times].sort();
  assert.deepEqual(times, sorted, '纯文本应按时间升序');
});

test('JSONL 每行都是合法 JSON', () => {
  const { events } = buildFixtureReport();
  const jsonl = toJsonl(events);
  for (const line of jsonl.split('\n')) JSON.parse(line);
});

test('文件名安全且带房号时间', () => {
  const { report } = buildFixtureReport();
  report.meta.title = 'a/b:c*d?e"f<g>h|i j';
  const stem = buildFileStem(report);
  assert.ok(!/[\\/:*?"<>|]/.test(stem), stem);
  assert.ok(stem.includes('12345678'));
});

test('上麦/下麦表格渲染：成对、进行中、闭麦备注、初始麦位', () => {
  const events = [
    { kind: 'seat', action: 'join', uid: '1', name: '甲', position: 0, t: 1000, source: 'join_time' },
    { kind: 'seat', action: 'join', uid: '2', name: '乙', position: 1, t: 2000, source: 'snapshot' },
    { kind: 'seat', action: 'mute', uid: '2', name: '乙', position: 1, t: 30000, source: 'snapshot' },
    { kind: 'seat', action: 'leave', uid: '1', name: '甲', position: 0, t: 61000, source: 'snapshot' },
  ];
  const session = {
    id: 's',
    roomId: '42',
    startedAt: 0,
    endedAt: 62000,
    meta: { title: 'X' },
    initialSeats: [{ name: '丙', position: 3, joinTime: 0 }],
  };
  const report = buildRoomReport(session, events);
  const md = renderRoomMarkdown(report);
  assert.match(md, /记录开始时已在麦上：丙（麦位 4）/);
  assert.match(md, /\| 1 分 00 秒 \| 快照检测 \|/, '甲应在麦 60 秒');
  assert.match(md, /上麦中/, '乙仍在麦上');
  assert.match(md, /闭麦/, '闭麦作为状态行');
});

test('卡片式：合并时间线里上麦行带麦位信息', () => {
  const events = [{ kind: 'seat', action: 'join', uid: '1', name: '甲', position: 2, t: 5000, source: 'join_time' }];
  const report = buildRoomReport({ id: 's', roomId: '42', startedAt: 0, endedAt: 9000, meta: { title: 'X' } }, events);
  const md = renderCombinedMarkdown([report]);
  assert.match(md, /\| 上麦中 \| 甲 \| 麦位 3 \|/);
});

