/** 把事件流聚合成人能读的「发言 / 上麦下麦 / 弹幕」结构。 */

export const SPEAKER_GAP_MS = 2500;

export function sortEvents(events) {
  return [...events].sort((a, b) => (a.t - b.t) || ((a.seq || 0) - (b.seq || 0)));
}

/**
 * 连续同一说话人、间隔不超过 maxGap 的 ASR 句子合并成一段发言。
 * 时长用各句 end-start 之和；开始时间按「收到时间 - 句子时长」估算。
 */
export function groupUtterances(events, maxGap = SPEAKER_GAP_MS) {
  const asr = sortEvents(events.filter((e) => e.kind === 'asr'));
  const out = [];
  let cur = null;
  for (const e of asr) {
    const dur = e.dur || 0;
    if (cur && cur.uid === e.uid && e.t - cur.lastT <= maxGap) {
      cur.parts.push(e);
      cur.lastT = Math.max(cur.lastT, e.t);
      cur.durMs += dur;
      cur.end = Math.max(cur.end, e.t);
    } else {
      cur = {
        uid: e.uid,
        name: e.name,
        parts: [e],
        start: Math.max(0, e.t - dur),
        end: e.t,
        lastT: e.t,
        durMs: dur,
      };
      out.push(cur);
    }
  }
  return out.map((u) => ({
    uid: u.uid,
    name: u.name,
    start: u.start,
    end: u.end,
    durMs: u.durMs,
    texts: u.parts.map((p) => p.text),
    text: joinText(u.parts.map((p) => p.text)),
    source: u.parts.some((p) => p.source === 'local') ? 'local' : 'bili',
    candidates: (u.parts[0] && u.parts[0].candidates) || [],
  }));
}

function joinText(parts) {
  let out = '';
  for (const raw of parts) {
    const piece = String(raw || '').trim();
    if (!piece) continue;
    if (!out) {
      out = piece;
      continue;
    }
    const needSep = !/[。！？，、；：,.!?;:]$/.test(out) && !/^[，。！？、；：,.!?;:]/.test(piece);
    out += (needSep ? '，' : '') + piece;
  }
  return out;
}

/**
 * 上麦→下麦配对，算出在麦时长。
 * 返回行类型：span（成对） / open（仍在麦上） / leave（只看到下麦） / note（换位、闭麦等）。
 */
export function pairSeats(events) {
  const rows = [];
  const open = new Map();
  for (const e of sortEvents(events.filter((x) => x.kind === 'seat'))) {
    if (e.action === 'join') {
      const prev = open.get(e.uid);
      if (prev) rows.push({ ...prev, type: 'span', endAt: e.t, note: '重新上麦' });
      open.set(e.uid, {
        type: 'open',
        uid: e.uid,
        name: e.name,
        position: e.position,
        startAt: e.t,
        source: e.source,
        note: e.source === 'join_time' ? '服务端上麦时间' : '快照检测',
      });
    } else if (e.action === 'leave') {
      const row = open.get(e.uid);
      if (row) {
        rows.push({ ...row, type: 'span', endAt: e.t, note: e.source === 'ws' ? 'WebSocket 事件' : '快照检测' });
        open.delete(e.uid);
      } else {
        rows.push({ type: 'leave', uid: e.uid, name: e.name, position: e.position, endAt: e.t, note: '仅检测到下麦' });
      }
    } else {
      rows.push({ type: 'note', uid: e.uid, name: e.name, position: e.position, at: e.t, note: actionLabel(e.action) });
    }
  }
  for (const row of open.values()) rows.push(row);
  return rows;
}

export function actionLabel(a) {
  return (
    {
      join: '上麦',
      leave: '下麦',
      move: '换麦位',
      mute: '闭麦',
      unmute: '开麦',
    }[a] || a
  );
}

export function buildRoomReport(session, rawEvents) {
  const events = sortEvents(rawEvents || []);
  const utterances = groupUtterances(events);
  const danmu = events.filter((e) => e.kind === 'danmu');
  const gifts = events.filter((e) => e.kind === 'gift' || e.kind === 'sc');
  const stats = events.filter((e) => e.kind === 'stat');
  const seats = pairSeats(events);

  const speakers = new Map();
  for (const u of utterances) {
    const s = speakers.get(u.uid) || { uid: u.uid, name: u.name, count: 0, durMs: 0, utterances: [] };
    s.count += u.texts.length;
    s.durMs += u.durMs;
    s.utterances.push(u);
    speakers.set(u.uid, s);
  }

  let onlineMax = 0;
  let onlineLast = 0;
  let popularityMax = 0;
  let popularityLast = 0;
  let watchedMax = 0;
  for (const e of stats) {
    if (e.online) {
      onlineMax = Math.max(onlineMax, e.online);
      onlineLast = e.online;
    }
    if (e.popularity) {
      popularityMax = Math.max(popularityMax, e.popularity);
      popularityLast = e.popularity;
    }
    if (e.watched) watchedMax = Math.max(watchedMax, e.watched);
  }
  const online = events.find((e) => e.kind === 'stat' && e.online);

  return {
    session,
    meta: session.meta || {},
    initialSeats: session.initialSeats || [],
    startedAt: session.startedAt,
    endedAt: session.endedAt || (events.length ? events[events.length - 1].t : session.startedAt),
    utterances,
    speakers: [...speakers.values()].sort((a, b) => b.durMs - a.durMs),
    seats,
    danmu,
    gifts,
    stats,
    onlineStart: online ? online.online : 0,
    onlineMax,
    onlineLast,
    popularityMax,
    popularityLast,
    watchedMax,
    counts: {
      utterances: utterances.length,
      sentences: utterances.reduce((n, u) => n + u.texts.length, 0),
      speakers: speakers.size,
      danmu: danmu.length,
      gifts: gifts.length,
      seatEvents: seats.length,
    },
  };
}
