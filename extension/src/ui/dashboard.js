import { listSessions, getEvents, getEventsSince, deleteSession, clearAll } from '../common/store.js';
import { buildRoomReport } from '../common/session.js';
import {
  renderRoomMarkdown,
  renderCombinedMarkdown,
  renderCompactText,
  toJsonl,
  buildFileStem,
  fmtClock,
  fmtDuration,
  fmtDateTime,
} from '../common/format.js';

const $ = (sel) => document.querySelector(sel);

let sessions = [];
let currentId = null;
let currentSession = null;
let events = [];
let report = null;
let activeTab = 'asr';
let lastSeq = 0;
let refreshBusy = false;
let asrStatus = null;

const KIND_LABEL = {
  asr: '语音',
  danmu: '弹幕',
  gift: '礼物',
  sc: 'SC',
  seat: '上麦',
  stat: '人气',
  meta: '房间',
  raw: '原始',
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function download(name, text, mime = 'text/markdown;charset=utf-8') {
  const blob = new Blob(['\ufeff', text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function asrText(s) {
  if (!s) return '未启用';
  if (s.state === 'ready') return `就绪（已识别 ${s.segments || 0} 段）`;
  if (s.state === 'downloading') return `下载模型中 ${s.progress || 0}%`;
  if (s.state === 'loading') return '加载模型中…';
  if (s.state === 'error') return `错误：${s.error || '未知'}`;
  return '待机';
}

function healthOf(s) {
  if (!s) return { cls: 'warn', text: '无数据' };
  if (s.status === 'recording') {
    if (s.diag && s.diag.paused) return { cls: 'warn', text: '已暂停' };
    const last = s.diag && s.diag.lastFrameAt;
    if (!last) return { cls: 'warn', text: '等待数据…' };
    const age = Date.now() - last;
    if (age > 90000) return { cls: 'warn', text: `${Math.round(age / 1000)} 秒未收到弹幕帧` };
    return { cls: 'live', text: '记录中' };
  }
  return { cls: '', text: '已结束' };
}

function renderList() {
  $('#sessionCount').textContent = `${sessions.length} 个房间`;
  const list = $('#sessionList');
  if (!sessions.length) {
    list.innerHTML = '<div class="empty">还没有记录。<br>打开一个 B 站语聊房页面后回到这里。</div>';
    return;
  }
  list.innerHTML = sessions
    .map((s) => {
      const h = healthOf(s);
      const c = s.counts || {};
      const dur = fmtDuration((s.endedAt || Date.now()) - s.startedAt);
      return `
      <div class="session-item ${s.id === currentId ? 'active' : ''}" data-id="${esc(s.id)}">
        <div class="si-title">${esc(s.title || '房间 ' + s.roomId)}</div>
        <div class="si-sub">${esc(s.roomId)} · ${dur} · ${fmtClock(s.startedAt)} 开始</div>
        <div class="si-stats">
          <span class="pill ${h.cls}">${h.text}</span>
          <span class="pill">语音 ${c.asr || 0}</span>
          <span class="pill">麦位 ${c.seat || 0}</span>
          <span class="pill">弹幕 ${c.danmu || 0}</span>
        </div>
      </div>`;
    })
    .join('');
  for (const el of list.querySelectorAll('.session-item')) {
    el.addEventListener('click', () => select(el.dataset.id));
  }
}

async function loadSessions() {
  sessions = await listSessions();
  if (!currentId && sessions.length) {
    await select(sessions[0].id);
    return;
  }
  if (currentId) {
    const found = sessions.find((s) => s.id === currentId);
    if (found) currentSession = found;
  }
  renderList();
}

async function select(id) {
  currentId = id;
  currentSession = sessions.find((s) => s.id === id) || null;
  events = await getEvents(id);
  lastSeq = events.length ? events[events.length - 1].seq : 0;
  report = buildRoomReport(currentSession || { id, roomId: '', startedAt: Date.now(), meta: {} }, events);
  renderList();
  renderHeader();
  renderPanel();
}

function renderHeader() {
  const s = currentSession;
  if (!s) {
    $('#roomTitle').textContent = '选择左侧房间';
    $('#roomMeta').innerHTML = '';
    $('#health').innerHTML = '';
    return;
  }
  const m = s.meta || {};
  $('#roomTitle').textContent = m.title || s.title || `房间 ${s.roomId}`;
  const bits = [
    `<span>房号 <b>${esc(s.roomId)}</b></span>`,
    m.anchor ? `<span>主播 <b>${esc(m.anchor)}</b></span>` : '',
    m.area ? `<span>${esc([m.parentArea, m.area].filter(Boolean).join(' / '))}</span>` : '',
    `<span>${fmtDateTime(s.startedAt)} – ${s.endedAt ? fmtClock(s.endedAt) : '进行中'}</span>`,
    `<span><a href="${esc(s.url || 'https://live.bilibili.com/' + s.roomId)}" target="_blank" rel="noreferrer">打开房间</a></span>`,
  ];
  $('#roomMeta').innerHTML = bits.filter(Boolean).join('');

  const h = healthOf(s);
  const d = s.diag || {};
  const last = d.lastFrameAt ? `${fmtClock(d.lastFrameAt)}（${Math.max(0, Math.round((Date.now() - d.lastFrameAt) / 1000))} 秒前）` : '尚未收到';
  const poll = d.pollOk === true ? '<span class="ok">正常</span>' : d.pollOk === false ? `<span class="err">失败：${esc(d.pollError || '未知')}</span>` : '<span class="muted">尚未轮询</span>';
  const src = s.asrEnabled === true ? 'B站 ASR' : s.asrEnabled === false ? '本地识别' : '自动判断';
  $('#health').innerHTML = [
    `<span>状态：<b class="${h.cls === 'live' ? 'ok' : h.cls === 'warn' ? 'warn' : ''}">${h.text}</b></span>`,
    `<span>语音来源：<b>${src}</b></span>`,
    `<span>最近弹幕帧：${last}</span>`,
    `<span>麦位快照：${poll}</span>`,
    `<span>累计帧：${d.framesTotal || 0}</span>`,
    `<span>消息：${d.messages || 0}（解码失败 ${d.decodeErrors || 0}）</span>`,
    `<span>本地识别：<b id="asrState">${esc(asrText(asrStatus))}</b></span>`,
    `<span>录音：<b>${(s.recordings || []).length} 个文件${d.rec && d.rec.on ? '（录音中）' : ''}</b></span>`,
  ].join(' &nbsp;|&nbsp; ');
}

function renderPanel() {
  const panel = $('#panel');
  if (!report) {
    panel.innerHTML = '<div class="empty">左侧选择一场记录</div>';
    return;
  }
  if (activeTab === 'asr') panel.innerHTML = asrHtml();
  else if (activeTab === 'seat') panel.innerHTML = seatHtml();
  else if (activeTab === 'danmu') panel.innerHTML = danmuHtml();
  else if (activeTab === 'rec') panel.innerHTML = recHtml();
  else panel.innerHTML = allHtml();
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function recHtml() {
  const s = currentSession || {};
  const list = s.recordings || [];
  const rec = (s.diag && s.diag.rec) || null;
  const live =
    rec && rec.on
      ? `<div class="center" style="text-align:left;padding:10px 12px">正在录音：${fmtDuration(Date.now() - (rec.startedAt || Date.now()))}（点扩展图标里的「停止并保存录音」结束）</div>`
      : '';
  if (!list.length) {
    return (
      live +
      '<div class="center">还没有录音文件。<br><span class="muted">点扩展图标 →「开始录音」，结束时点「停止并保存录音」，文件会保存到浏览器下载目录。</span></div>'
    );
  }
  return (
    live +
    `<table><thead><tr><th>文件</th><th style="width:90px">时长</th><th style="width:90px">大小</th><th style="width:150px">开始时间</th></tr></thead><tbody>${list
      .slice()
      .reverse()
      .map(
        (r) =>
          `<tr><td class="text">${esc(r.filename)}</td><td>${fmtDuration(r.durationMs)}</td><td>${fmtSize(r.size)}</td><td class="time">${fmtDateTime(r.startedAt)}</td></tr>`,
      )
      .join('')}</tbody></table>`
  );
}

function asrHtml() {
  const list = report.utterances;
  if (!list.length) {
    return '<div class="center">还没有语音转写。<br><span class="muted">需要房间开启 ASR（多人语音房一般自带），且有人在说话。若长时间为空，请查看上方“最近弹幕帧”。</span></div>';
  }
  const rows = list
    .slice(-800)
    .map(
      (u) =>
        `<tr><td class="time">${fmtClock(u.start)}–${fmtClock(u.end)}</td><td class="name">${esc(u.name)}${u.source === 'local' ? ' <span class="tag">本地</span>' : ''}</td><td class="text">${esc(u.text)}</td><td class="time">${fmtDuration(u.durMs)}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th style="width:120px">时间</th><th style="width:150px">说话人</th><th>内容</th><th style="width:90px">时长</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function seatHtml() {
  const rows = report.seats;
  const out = [];
  const initialSeats = report.initialSeats || [];
  if (initialSeats.length) {
    const names = initialSeats
      .map((s) => esc(s.name) + (s.position >= 0 ? '（麦位 ' + (s.position + 1) + '）' : ''))
      .join('、');
    out.push('<div class="center" style="padding:10px 12px;text-align:left">记录开始时已在麦上：' + names + '</div>');
  }
  if (!rows.length) return out.join('') + '<div class="center">还没有上麦/下麦变化。</div>';
  const head =
    '<table><thead><tr><th style="width:110px">时间</th><th style="width:90px">事件</th><th style="width:70px">麦位</th><th style="width:160px">用户</th><th style="width:110px">在麦时长</th><th>说明</th></tr></thead><tbody>';
  const body = rows
    .map((r) => {
      const pos = r.position >= 0 ? r.position + 1 : '—';
      if (r.type === 'open') {
        return '<tr><td class="time">' + fmtClock(r.startAt) + '</td><td>上麦中</td><td>' + pos + '</td><td class="name">' + esc(r.name) + '</td><td>仍在麦上</td><td class="muted">' + esc(r.note) + '</td></tr>';
      }
      if (r.type === 'span') {
        return '<tr><td class="time">' + fmtClock(r.startAt) + '</td><td>上麦</td><td>' + pos + '</td><td class="name">' + esc(r.name) + '</td><td>' + fmtDuration(r.endAt - r.startAt) + '</td><td class="muted">' + esc(r.note) + '</td></tr>';
      }
      if (r.type === 'leave') {
        return '<tr><td class="time">' + fmtClock(r.endAt) + '</td><td>下麦</td><td>' + pos + '</td><td class="name">' + esc(r.name) + '</td><td>—</td><td class="muted">' + esc(r.note) + '</td></tr>';
      }
      return '<tr><td class="time">' + fmtClock(r.at) + '</td><td>' + esc(r.note) + '</td><td>' + pos + '</td><td class="name">' + esc(r.name) + '</td><td>—</td><td class="muted">状态变化</td></tr>';
    })
    .join('');
  return out.join('') + head + body + '</tbody></table>';
}

function danmuHtml() {
  const list = report.danmu;
  if (!list.length) return '<div class="center">还没有弹幕。</div>';
  return `<table><thead><tr><th style="width:110px">时间</th><th style="width:150px">用户</th><th>内容</th></tr></thead><tbody>${list
    .slice(-1000)
    .map((d) => `<tr><td class="time">${fmtClock(d.t)}</td><td class="name">${esc(d.name)}</td><td class="text">${esc(d.text)}</td></tr>`)
    .join('')}</tbody></table>`;
}

function allHtml() {
  const list = events.slice(-500);
  if (!list.length) return '<div class="center">暂无事件。</div>';
  return `<table><thead><tr><th style="width:100px">时间</th><th style="width:80px">类型</th><th style="width:150px">用户</th><th>内容</th></tr></thead><tbody>${list
    .map(
      (e) =>
        `<tr><td class="time">${fmtClock(e.t)}</td><td><span class="tag">${KIND_LABEL[e.kind] || e.kind}</span></td><td class="name">${esc(e.name || '')}</td><td class="text">${esc(e.text || (e.kind === 'seat' ? e.action : ''))}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

async function refreshCurrent() {
  if (!currentId || refreshBusy) return;
  refreshBusy = true;
  try {
    const found = sessions.find((s) => s.id === currentId);
    if (found) currentSession = found;
    const fresh = await getEventsSince(currentId, lastSeq);
    if (fresh.length) {
      events = events.concat(fresh);
      lastSeq = fresh[fresh.length - 1].seq;
      report = buildRoomReport(currentSession || {}, events);
      renderPanel();
    }
    renderHeader();
  } catch (e) {
    console.warn(e);
  } finally {
    refreshBusy = false;
  }
}

function bind() {
  $('#refreshBtn').addEventListener('click', async () => {
    await loadSessions();
    if (currentId) await select(currentId);
  });

  for (const b of document.querySelectorAll('.tab')) {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      activeTab = b.dataset.tab;
      renderPanel();
    });
  }

  $('#exportMdBtn').addEventListener('click', () => {
    if (!report) return;
    download(`${buildFileStem(report)}.md`, renderRoomMarkdown(report));
  });

  $('#exportJsonlBtn').addEventListener('click', () => {
    if (!report) return;
    download(`${buildFileStem(report)}.jsonl`, toJsonl(events), 'application/x-ndjson;charset=utf-8');
  });

  $('#exportTxtBtn').addEventListener('click', () => {
    if (!report) return;
    download(`${buildFileStem(report)}.txt`, renderCompactText(report), 'text/plain;charset=utf-8');
  });

  $('#copyTxtBtn').addEventListener('click', async (ev) => {
    if (!report) return;
    const text = renderCompactText(report);
    const btn = ev.currentTarget;
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => (btn.textContent = old), 1500);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      btn.textContent = '已复制';
      setTimeout(() => (btn.textContent = '复制全文'), 1500);
    }
  });

  $('#exportAllBtn').addEventListener('click', async () => {
    const all = await listSessions();
    if (!all.length) return;
    const reports = [];
    for (const s of all) {
      const evs = await getEvents(s.id);
      reports.push(buildRoomReport(s, evs));
    }
    const stamp = fmtDateTime(Date.now()).replace(/[-: ]/g, '');
    download(`全部语聊房_${stamp}.md`, renderCombinedMarkdown(reports));
  });

  $('#deleteBtn').addEventListener('click', async () => {
    if (!currentId) return;
    if (!confirm('删除这场记录？不可恢复。')) return;
    await deleteSession(currentId);
    currentId = null;
    currentSession = null;
    report = null;
    events = [];
    await loadSessions();
    renderHeader();
    renderPanel();
  });

  $('#clearAllBtn').addEventListener('click', async () => {
    if (!confirm('清空全部房间的记录？不可恢复。')) return;
    await clearAll();
    currentId = null;
    currentSession = null;
    report = null;
    events = [];
    await loadSessions();
    renderHeader();
    renderPanel();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'session-updated') {
      const i = sessions.findIndex((s) => s.id === msg.session.id);
      if (i >= 0) sessions[i] = msg.session;
      else if (msg.session.status === 'recording') sessions.unshift(msg.session);
      if (msg.session.id === currentId) currentSession = msg.session;
      renderList();
      renderHeader();
    } else if (msg && msg.type === 'asr-status') {
      asrStatus = msg.status;
      const el = document.getElementById('asrState');
      if (el) el.textContent = asrText(asrStatus);
    }
  });
}

async function main() {
  bind();
  await loadSessions();
  chrome.runtime
    .sendMessage({ type: 'asr-status-get' })
    .then((r) => {
      asrStatus = r && r.status ? r.status : null;
      renderHeader();
    })
    .catch(() => {});
  setInterval(() => {
    loadSessions().catch(() => {});
    refreshCurrent();
  }, 2500);
  setInterval(refreshCurrent, 1200);
}

main();
