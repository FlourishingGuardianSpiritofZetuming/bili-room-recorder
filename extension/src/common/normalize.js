/**
 * 把 B 站下发的原始 cmd 消息归一化成统一事件。
 *
 * 统一事件：
 * {
 *   kind: 'asr'|'danmu'|'gift'|'sc'|'seat'|'stat'|'meta'|'raw',
 *   t: number,          // 本机收到时间（ms epoch），排序/对齐以此为准
 *   uid: string,
 *   name: string,
 *   text: string,
 *   ...额外字段
 * }
 */

const T = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function asText(v) {
  if (v == null) return '';
  return String(v).replace(/\r\n?/g, '\n').trim();
}

/** DANMU_MSG 的字段位置做足防御，B 站偶尔会裁剪 info。 */
export function normalizeDanmu(json, recvAt) {
  const info = json && json.info;
  if (!Array.isArray(info) || info.length < 3) return null;
  const text = asText(info[1]);
  if (!text) return null;
  const meta = info[0] || [];
  const user = info[2] || [];
  const uid = String(user[0] ?? '');
  const name = asText(user[1]) || '匿名用户';
  let extra = null;
  try {
    const raw = meta[15] && (meta[15].extra || meta[15]);
    extra = typeof raw === 'string' ? JSON.parse(raw) : raw || null;
  } catch {
    extra = null;
  }
  const sentTs = T(meta[4]) || (info[9] && T(info[9].ts)) || recvAt;
  const id = (extra && (extra.id_str || extra.id)) || meta[7] || `${uid}:${sentTs}:${text}`;
  return {
    kind: 'danmu',
    t: recvAt,
    sentTs,
    id: String(id),
    uid,
    name,
    text,
    medal: Array.isArray(info[3]) && info[3][1] ? `${info[3][1]}` : '',
    guard: (Array.isArray(info[7]) && T(info[7][0])) || 0,
  };
}

/**
 * UNIVERSAL_ASR_TEXT —— B 站语音房自带的实时转写，天然带「谁在说」。
 * data: {uid, uname, channel_id, sentences:[{start_time, end_time, text, is_append}]}
 * start_time/end_time 是「该说话人音频通道」的相对毫秒，不同人基准不同，
 * 因此时间轴一律用本机收到时间，时长 = end - start。
 */
export function normalizeAsr(json, recvAt) {
  const d = json && json.data;
  if (!d || !Array.isArray(d.sentences)) return [];
  const uid = String(d.uid ?? '');
  const name = asText(d.uname) || '未知说话人';
  const out = [];
  for (const s of d.sentences) {
    const text = asText(s && s.text);
    if (!text) continue;
    const dur = Math.max(0, T(s.end_time) - T(s.start_time));
    out.push({
      kind: 'asr',
      t: recvAt,
      uid,
      name,
      text,
      dur: dur > 0 && dur < 60000 ? dur : 0,
      append: !!s.is_append,
      channel: String(d.channel_id ?? ''),
    });
  }
  return out;
}

export function normalizeSuperChat(json, recvAt) {
  const d = json && json.data;
  if (!d) return null;
  const text = asText(d.message);
  if (!text) return null;
  const uid = String(d.uid ?? '');
  return {
    kind: 'sc',
    t: recvAt,
    uid,
    name: asText(d.user_info && d.user_info.uname) || '用户',
    text,
    price: T(d.price),
    id: String(d.id ?? ''),
  };
}

export function normalizeGift(json, recvAt) {
  const d = json && json.data;
  if (!d) return null;
  const name = asText(d.uname || (d.sender_uinfo && d.sender_uinfo.base && d.sender_uinfo.base.name));
  const gift = asText(d.giftName || d.gift_name || '礼物');
  const num = T(d.num) || 1;
  if (!name && !gift) return null;
  return {
    kind: 'gift',
    t: recvAt,
    uid: String(d.uid ?? ''),
    name: name || '用户',
    text: `${gift} ×${num}`,
    price: T(d.total_coin || d.price || 0),
    num,
  };
}

/** 单麦位房（非多人语音）的上麦/下麦事件。 */
export function normalizeVoiceJoin(json, recvAt) {
  const d = json && json.data;
  if (!d) return null;
  const uid = String(d.uid ?? '');
  const on = Number(d.status) === 1;
  return {
    kind: 'seat',
    t: recvAt,
    action: on ? 'join' : 'leave',
    uid,
    name: asText(d.user_name) || (uid ? `UID ${uid}` : '未知'),
    position: 0,
    source: 'ws',
    serverAt: T(d.start_at) ? T(d.start_at) * 1000 : 0,
  };
}

export function normalizeStat(json, recvAt) {
  const cmd = String((json && json.cmd) || '').split(':')[0];
  const d = (json && json.data) || {};
  if (cmd === 'ONLINE_RANK_COUNT') {
    const n = T(d.online_count) || T(d.count);
    return n ? { kind: 'stat', t: recvAt, online: n } : null;
  }
  if (cmd === 'WATCHED_CHANGE') {
    const n = T(d.num);
    return n ? { kind: 'stat', t: recvAt, watched: n } : null;
  }
  if (cmd === 'ROOM_REAL_TIME_MESSAGE_UPDATE') {
    return { kind: 'stat', t: recvAt, fans: T(d.fans), fansClub: T(d.fans_club) };
  }
  if (cmd === 'ROOM_CHANGE') {
    return { kind: 'meta', t: recvAt, title: asText(d.title) };
  }
  return null;
}

/**
 * 解析一条已解压的 WS 消息，返回零到多条统一事件。
 */
export function normalizeMessage(json, recvAt) {
  const cmd = String((json && json.cmd) || '').split(':')[0];
  switch (cmd) {
    case 'DANMU_MSG': {
      const e = normalizeDanmu(json, recvAt);
      return e ? [e] : [];
    }
    case 'UNIVERSAL_ASR_TEXT':
      return normalizeAsr(json, recvAt);
    case 'SUPER_CHAT_MESSAGE':
    case 'SUPER_CHAT_MESSAGE_JPN': {
      const e = normalizeSuperChat(json, recvAt);
      return e ? [e] : [];
    }
    case 'SEND_GIFT':
    case 'COMBO_SEND': {
      const e = normalizeGift(json, recvAt);
      return e ? [e] : [];
    }
    case 'VOICE_JOIN_STATUS': {
      const e = normalizeVoiceJoin(json, recvAt);
      return e ? [e] : [];
    }
    case 'ONLINE_RANK_COUNT':
    case 'WATCHED_CHANGE':
    case 'ROOM_REAL_TIME_MESSAGE_UPDATE':
    case 'ROOM_CHANGE': {
      const e = normalizeStat(json, recvAt);
      return e ? [e] : [];
    }
    case 'UNIVERSAL_INTERACT_JOIN':
    case 'UNIVERSAL_INTERACT_LEAVE':
    case 'UNIVERSAL_INTERACT_OPERATION':
    case 'UNIVERSAL_INTERACT_INVITATION':
    case 'MULTI_VOICE_APPLICATION':
    case 'MULTI_VOICE_APPLICATION_USER':
    case 'MULTI_VOICE_OWNER_LEAVE': {
      // 结构未公开稳定，原样留存，方便日后解析 / 排查
      return [{ kind: 'raw', t: recvAt, cmd, text: '', payload: json }];
    }
    default:
      return [];
  }
}

/** 从 getInfoByRoom 的返回值里抽取房间元信息。 */
export function extractRoomMeta(data) {
  if (!data) return null;
  const r = data.room_info || {};
  const a = (data.anchor_info && data.anchor_info.base_info) || {};
  return {
    roomId: String(r.room_id ?? ''),
    shortId: String(r.short_id ?? ''),
    title: asText(r.title),
    anchor: asText(a.uname),
    anchorUid: String(a.uid ?? ''),
    area: asText(r.area_name),
    parentArea: asText(r.parent_area_name),
    cover: asText(r.cover),
    liveStatus: T(r.live_status),
    online: T(r.online),
    popularity: T(r.online),
    attention: T(r.attention),
    liveStartTime: asText(r.live_start_time),
    description: asText(r.description).slice(0, 300),
  };
}

/** 把 universal_interact_info_v2 / multi_voice / voice_join_info 统一成座位快照。 */
export function extractSeats(data) {
  if (!data) return [];
  const seats = [];
  const ui = data.universal_interact_info_v2 || data.universal_interact_info;
  const members = (ui && ui.members) || [];
  for (const m of members) {
    const mv = (m.biz_extra_data && m.biz_extra_data.multi_voice) || null;
    seats.push({
      uid: String(m.uid ?? ''),
      name: asText(m.uname || m.display_name) || '未知',
      position: Number.isFinite(m.position) ? m.position : -1,
      joinTime: T(m.join_time) * 1000,
      mute: mv ? Number(mv.is_mute) === 1 : false,
      role: mv ? T(mv.role) : 0,
      roomOwner: String((mv && mv.room_owner_uid) || ''),
    });
  }
  // 单人连麦房
  const vj = data.voice_join_info && data.voice_join_info.status;
  if (!seats.length && vj && T(vj.uid) && Number(vj.status) === 1) {
    seats.push({
      uid: String(vj.uid),
      name: asText(vj.user_name) || '未知',
      position: 0,
      joinTime: T(vj.start_at) * 1000,
      mute: false,
      role: 0,
      roomOwner: '',
      single: true,
    });
  }
  return seats;
}

/**
 * 对比前后两次座位快照，产出上麦/下麦/换麦位/静音事件。
 * 「上麦时间」优先用服务端 join_time，异常时退回本机检测时间。
 */
export function diffSeats(prevSeats, nextSeats, at) {
  const prev = new Map((prevSeats || []).map((s) => [s.uid, s]));
  const next = new Map((nextSeats || []).map((s) => [s.uid, s]));
  const events = [];
  for (const [uid, s] of next) {
    const p = prev.get(uid);
    if (!p) {
      const serverAt = s.joinTime && Math.abs(at - s.joinTime) < 12 * 3600 * 1000 ? s.joinTime : 0;
      events.push({
        kind: 'seat',
        t: serverAt || at,
        detectedAt: at,
        action: 'join',
        uid,
        name: s.name,
        position: s.position,
        mute: s.mute,
        source: serverAt ? 'join_time' : 'snapshot',
      });
    } else {
      if (p.position !== s.position) {
        events.push({ kind: 'seat', t: at, detectedAt: at, action: 'move', uid, name: s.name, from: p.position, position: s.position, source: 'snapshot' });
      }
      if (p.mute !== s.mute) {
        events.push({ kind: 'seat', t: at, detectedAt: at, action: s.mute ? 'mute' : 'unmute', uid, name: s.name, position: s.position, source: 'snapshot' });
      }
    }
  }
  for (const [uid, p] of prev) {
    if (!next.has(uid)) {
      events.push({ kind: 'seat', t: at, detectedAt: at, action: 'leave', uid, name: p.name, position: p.position, source: 'snapshot' });
    }
  }
  return events;
}
