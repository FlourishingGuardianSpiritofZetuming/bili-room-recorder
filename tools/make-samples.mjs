// 用真实抓包样本生成示例导出文件（docs/）。
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeMessage } from '../extension/src/common/normalize.js';
import { buildRoomReport } from '../extension/src/common/session.js';
import { renderRoomMarkdown, renderCombinedMarkdown, renderCompactText, toJsonl } from '../extension/src/common/format.js';

const lines = readFileSync('tests/fixtures/room-A.jsonl', 'utf8').trim().split('\n');
const events = [];
let seq = 0;
for (const line of lines) {
  const o = JSON.parse(line);
  for (const e of normalizeMessage(o.json, o.ts)) {
    e.seq = ++seq;
    e.sid = 's1';
    events.push(e);
  }
}

const startedAt = events.length ? events[0].t : Date.now();
const endedAt = events.length ? events[events.length - 1].t : startedAt;

// 插两条真实存在的上下麦事件（时间落在记录区间内），让示例能展示这一节
const seatBase = startedAt + Math.round((endedAt - startedAt) * 0.2);
events.push({ kind: 'seat', action: 'join', uid: '1001', name: '示例用户A', position: 1, t: seatBase, source: 'join_time', seq: ++seq, sid: 's1' });
events.push({ kind: 'seat', action: 'leave', uid: '1001', name: '示例用户A', position: 1, t: seatBase + 96000, source: 'snapshot', seq: ++seq, sid: 's1' });
events.push({ kind: 'seat', action: 'join', uid: '1002', name: '示例用户B', position: 5, t: seatBase + 12000, source: 'join_time', seq: ++seq, sid: 's1' });

const session = {
  id: 's1',
  roomId: '12345678',
  title: '示例语聊房',
  url: 'https://live.bilibili.com/12345678',
  startedAt,
  endedAt,
  meta: { title: '示例语聊房', anchor: '示例主播', area: '交友', parentArea: '聊天室' },
  initialSeats: [
    { uid: '1', name: '示例主播', position: 0, joinTime: startedAt - 3600000 },
    { uid: '2', name: '示例用户A', position: 1, joinTime: startedAt - 1200000 },
    { uid: '3', name: '示例用户B', position: 5, joinTime: startedAt - 900000 },
  ],
};

const report = buildRoomReport(session, events);
writeFileSync('docs/示例-单房间记录.md', renderRoomMarkdown(report));
writeFileSync('docs/示例-合并记录.md', renderCombinedMarkdown([report]));
writeFileSync('docs/示例-纯文本.txt', renderCompactText(report));
writeFileSync('docs/示例-原始事件.jsonl', toJsonl(events.slice(0, 40)));
console.log('utterances', report.utterances.length, 'danmu', report.danmu.length, 'speakers', report.speakers.length, 'seats', report.seats.length);


