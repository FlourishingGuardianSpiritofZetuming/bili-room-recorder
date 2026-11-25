/** 渲染成 Markdown / 纯文本 / JSONL。 */

const pad = (n) => String(n).padStart(2, '0');

export function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtDateTime(ms) {
  return `${fmtDate(ms)} ${fmtClock(ms)}`;
}

export function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 10000) return `${(ms / 1000).toFixed(1)} 秒`;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${pad(s)} 秒`;
  return `${s} 秒`;
}

const esc = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
    .trim();

const num = (n) => Number(n || 0).toLocaleString('zh-CN');

function header(report, { headingLevel = 1 } = {}) {
  const h = '#'.repeat(headingLevel);
  const m = report.meta || {};
  const s = report.session || {};
  const roomId = s.roomId || m.roomId || '';
  const url = s.url || (roomId ? `https://live.bilibili.com/${roomId}` : '');
  const lines = [];
  lines.push(`${h} 语聊房记录 · ${m.title || s.title || `房间 ${roomId}`}`);
  lines.push('');
  if (url) lines.push(`- 房间：${url}`);
  if (roomId) lines.push(`- 房号：${roomId}`);
  if (m.anchor) lines.push(`- 主播：${m.anchor}`);
  if (m.area) lines.push(`- 分区：${[m.parentArea, m.area].filter(Boolean).join(' / ')}`);
  if (s.asrEnabled === true) lines.push('- 语音来源：B 站 ASR');
  else if (s.asrEnabled === false) lines.push('- 语音来源：本地离线识别（该房间未开启 B 站 ASR）');
  lines.push(`- 记录时间：${fmtDateTime(report.startedAt)} – ${fmtClock(report.endedAt)}（${fmtDuration(report.endedAt - report.startedAt)}）`);
  const onlineBits = [];
  if (report.popularityMax) onlineBits.push(`人气峰值 ${num(report.popularityMax)}`);
  if (report.onlineMax) onlineBits.push(`在线观众峰值 ${num(report.onlineMax)}`);
  if (report.watchedMax) onlineBits.push(`累计看过 ${num(report.watchedMax)}`);
  if (onlineBits.length) lines.push(`- 热度：${onlineBits.join(' · ')}`);
  const localSegments = report.utterances.filter((u) => u.source === 'local').length;
  lines.push(
    `- 本场统计：语音 ${report.counts.utterances} 段（${report.counts.sentences} 句，${report.counts.speakers} 位说话人${localSegments ? `，其中本地识别 ${localSegments} 段` : ''}）· 上麦相关 ${report.counts.seatEvents} 条 · 弹幕 ${report.counts.danmu} 条 · 礼物/SC ${report.counts.gifts} 条`,
  );
  return lines.join('\n');
}

function seatTable(rows) {
  if (!rows.length) return '（本次记录未捕获到上麦/下麦变化）';
  const lines = ['| 时间 | 事件 | 麦位 | 用户 | 在麦时长 | 说明 |', '| --- | --- | --- | --- | --- | --- |'];
  for (const r of rows) {
    const pos = r.position >= 0 ? r.position + 1 : '—';
    if (r.type === 'open') {
      lines.push(`| ${fmtClock(r.startAt)} | 上麦中 | ${pos} | ${esc(r.name)} | 仍在麦上 | ${esc(r.note)} |`);
    } else if (r.type === 'span') {
      lines.push(`| ${fmtClock(r.startAt)} | 上麦 | ${pos} | ${esc(r.name)} | ${fmtDuration(r.endAt - r.startAt)} | ${esc(r.note)} |`);
    } else if (r.type === 'leave') {
      lines.push(`| ${fmtClock(r.endAt)} | 下麦 | ${pos} | ${esc(r.name)} | — | ${esc(r.note)} |`);
    } else {
      lines.push(`| ${fmtClock(r.at)} | ${esc(r.note)} | ${pos} | ${esc(r.name)} | — | 状态变化 |`);
    }
  }
  return lines.join('\n');
}

export function renderRoomMarkdown(report, opts = {}) {
  const h = (n) => '#'.repeat(n + (opts.headingOffset || 0));
  const out = [];
  out.push(header(report, { headingLevel: 1 + (opts.headingOffset || 0) }));
  out.push('');

  out.push(`${h(2)} 一、发言时间线`);
  out.push('');
  if (!report.utterances.length) {
    out.push('（本次记录没有语音转写数据。可能原因：房间未开启 ASR、不是多人语音房、或记录开始后无人说话。）');
  } else {
    out.push('| # | 时间 | 说话人 | 内容 | 时长 |');
    out.push('| --- | --- | --- | --- | --- |');
    report.utterances.forEach((u, i) => {
      const tag = u.source === 'local' ? '（本地）' : '';
      out.push(`| ${i + 1} | ${fmtClock(u.start)}–${fmtClock(u.end)} | ${esc(u.name + tag)} | ${esc(u.text)} | ${fmtDuration(u.durMs)} |`);
    });
  }
  out.push('');

  out.push(`${h(2)} 二、按说话人汇总`);
  out.push('');
  if (!report.speakers.length) {
    out.push('（无）');
  } else {
    for (const s of report.speakers) {
      out.push(`${h(3)} ${esc(s.name)} · ${s.count} 句 · 约 ${fmtDuration(s.durMs)}`);
      out.push('');
      for (const u of s.utterances) {
        out.push(`- \`${fmtClock(u.start)}\` ${esc(u.text).replace(/<br>/g, ' ')}`);
      }
      out.push('');
    }
  }

  out.push(`${h(2)} 三、上麦 / 下麦`);
  out.push('');
  if (report.initialSeats && report.initialSeats.length) {
    out.push(
      `记录开始时已在麦上：${report.initialSeats
        .map((s) => `${esc(s.name)}${s.position >= 0 ? `（麦位 ${s.position + 1}）` : ''}`)
        .join('、')}`,
    );
    out.push('');
  }
  out.push(seatTable(report.seats));
  out.push('');

  out.push(`${h(2)} 四、弹幕`);
  out.push('');
  if (!report.danmu.length) {
    out.push('（无）');
  } else {
    out.push('| 时间 | 用户 | 内容 |');
    out.push('| --- | --- | --- |');
    for (const d of report.danmu) out.push(`| ${fmtClock(d.t)} | ${esc(d.name)} | ${esc(d.text)} |`);
  }
  out.push('');

  if (report.gifts.length) {
    out.push(`${h(2)} 五、礼物 / 醒目留言`);
    out.push('');
    out.push('| 时间 | 用户 | 内容 | 金额（金瓜子） |');
    out.push('| --- | --- | --- | --- |');
    for (const g of report.gifts) out.push(`| ${fmtClock(g.t)} | ${esc(g.name)} | ${esc(g.text)} | ${g.price ? num(g.price) : '—'} |`);
    out.push('');
  }

  const statRows = report.stats.filter((s) => s.online || s.popularity || s.watched);
  if (statRows.length) {
    out.push(`${h(2)} 六、热度变化`);
    out.push('');
    out.push('| 时间 | 人气 | 在线观众 | 累计看过 |');
    out.push('| --- | --- | --- | --- |');
    const last = { pop: '', online: '', watched: '' };
    for (const s of statRows) {
      if (s.popularity) last.pop = num(s.popularity);
      if (s.online) last.online = num(s.online);
      if (s.watched) last.watched = num(s.watched);
      out.push(`| ${fmtClock(s.t)} | ${last.pop || '—'} | ${last.online || '—'} | ${last.watched || '—'} |`);
    }
    out.push('');
  }

  out.push(`${h(2)} 附注`);
  out.push('');
  out.push('- “发言”来自 B 站语音房下发的实时 ASR 转写（`UNIVERSAL_ASR_TEXT`），说话人由 B 站给出，非本地识别。');
  const localCount = report.utterances.filter((u) => u.source === 'local').length;
  if (localCount) {
    out.push(
      `- 其中 ${localCount} 段来自**本地识别**（该房间未开启 B 站 ASR）。本地识别只能拿到混音，说话人按“当前开麦的人”推断：只有 1 人开麦时精确归属，多人开麦时标为“麦上多人”。`,
    );
    const cand = report.utterances.find((u) => u.source === 'local' && u.candidates && u.candidates.length);
    if (cand) out.push(`- 多人开麦时的候选（按当时麦位快照）：${cand.candidates.map((n) => esc(n)).join('、')}`);
  }
  out.push('- “上麦/下麦”来自房间成员快照轮询（含服务端 `join_time`）以及 `VOICE_JOIN_STATUS` 等 WebSocket 事件；下麦时间最多有 1 个轮询周期的误差。');
  out.push(`- 本文件由「B站语聊房记录器」生成于 ${fmtDateTime(Date.now())}。`);
  return out.join('\n');
}

export function renderCombinedMarkdown(reports, opts = {}) {
  const list = reports.filter(Boolean);
  if (!list.length) return '# 多语聊房合并记录\n\n（没有可导出的记录）\n';
  const from = Math.min(...list.map((r) => r.startedAt));
  const to = Math.max(...list.map((r) => r.endedAt));
  const out = [];
  out.push('# 多语聊房合并记录');
  out.push('');
  out.push(`- 导出时间：${fmtDateTime(Date.now())}`);
  out.push(`- 房间数：${list.length}`);
  out.push(`- 时间范围：${fmtDateTime(from)} – ${fmtClock(to)}`);
  out.push('');

  out.push('## 房间清单');
  out.push('');
  out.push('| # | 房间 | 房号 | 记录时段 | 时长 | 语音段 | 弹幕 |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  list.forEach((r, i) => {
    out.push(
      `| ${i + 1} | ${esc(r.meta.title || r.session.title || r.session.roomId)} | ${r.session.roomId} | ${fmtClock(r.startedAt)}–${fmtClock(r.endedAt)} | ${fmtDuration(r.endedAt - r.startedAt)} | ${r.counts.utterances} | ${r.counts.danmu} |`,
    );
  });
  out.push('');

  out.push('## 合并时间线');
  out.push('');
  out.push('| 时间 | 房间 | 类型 | 用户 | 内容 |');
  out.push('| --- | --- | --- | --- | --- |');
  const rows = [];
  for (const r of list) {
    const room = r.meta.title || r.session.title || r.session.roomId;
    for (const u of r.utterances) rows.push({ t: u.start, room, type: '发言', name: u.name, text: u.text });
    for (const s of r.seats) {
      const label = s.type === 'open' ? '上麦中' : s.type === 'span' ? '上麦' : s.type === 'leave' ? '下麦' : s.note;
      rows.push({ t: s.startAt || s.at || s.endAt, room, type: label, name: s.name, text: s.position >= 0 ? `麦位 ${s.position + 1}` : '' });
    }
    for (const d of r.danmu) rows.push({ t: d.t, room, type: '弹幕', name: d.name, text: d.text });
  }
  rows.sort((a, b) => a.t - b.t);
  for (const row of rows) out.push(`| ${fmtClock(row.t)} | ${esc(row.room)} | ${row.type} | ${esc(row.name)} | ${esc(row.text)} |`);
  out.push('');

  out.push('## 各房间明细');
  out.push('');
  list.forEach((r) => {
    out.push(renderRoomMarkdown(r, { headingOffset: 1 }));
    out.push('');
    out.push('---');
    out.push('');
  });
  return out.join('\n');
}

/** 纯文本紧凑版：适合直接粘到聊天窗口/笔记里。 */
export function renderCompactText(report) {
  const m = report.meta || {};
  const s = report.session || {};
  const out = [];
  out.push(`【${m.title || s.title || s.roomId}】${s.roomId ? ` https://live.bilibili.com/${s.roomId}` : ''}`);
  out.push(`${fmtDateTime(report.startedAt)} – ${fmtClock(report.endedAt)}，发言 ${report.counts.utterances} 段，弹幕 ${report.counts.danmu} 条`);
  out.push('');
  const lines = [];
  for (const u of report.utterances) lines.push({ t: u.start, text: `[${fmtClock(u.start)}] ${u.name}：${u.text}` });
  for (const d of report.danmu) lines.push({ t: d.t, text: `[${fmtClock(d.t)}] 弹幕 ${d.name}：${d.text}` });
  lines.sort((a, b) => a.t - b.t);
  for (const l of lines) out.push(l.text);
  return out.join('\n');
}

export function toJsonl(events) {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

export function buildFileStem(report, index = 0) {
  const m = report.meta || {};
  const s = report.session || {};
  const title = String(m.title || s.title || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  const stamp = fmtDate(report.startedAt).replace(/-/g, '') + '-' + fmtClock(report.startedAt).replace(/:/g, '');
  return `${String(index + 1).padStart(2, '0')}_${title || '房间'}${s.roomId ? '_' + s.roomId : ''}_${stamp}`;
}
