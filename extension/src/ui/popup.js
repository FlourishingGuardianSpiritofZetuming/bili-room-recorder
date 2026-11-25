const $ = (s) => document.querySelector(s);

let tab = null;
let paused = false;
let state = null;
let savedRecordings = 0;
let flash = { text: '', until: 0 };

function row(k, v, cls = '') {
  return `<div class="row"><span class="k">${k}</span><span class="v ${cls}" title="${String(v ?? '')}">${v ?? '—'}</span></div>`;
}

function clock(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function render() {
  const info = $('#info');
  const tip = $('#tip');
  if (!tab) {
    info.innerHTML = row('状态', '没有活动标签页');
    return;
  }
  if (!/^https:\/\/live\.bilibili\.com\//.test(tab.url || '')) {
    info.innerHTML = row('状态', '当前不是直播/语聊房页面', 'warn');
    tip.innerHTML = '打开 B 站语聊房页面（live.bilibili.com/房号）后，本扩展会自动开始记录。';
    $('#toggleBtn').disabled = true;
    return;
  }
  const s = state || {};
  info.innerHTML = [
    row('房间', (s.roomId || '解析中') + (tab.title ? ` · ${tab.title.slice(0, 14)}` : '')),
    row('采集帧', s.framesTotal ?? 0),
    row('最近一帧', clock(s.lastFrameAt)),
    row('麦位快照', s.pollOk === true ? '正常' : s.pollOk === false ? `失败：${s.pollError || ''}` : '等待中', s.pollOk === false ? 'err' : s.pollOk === true ? 'ok' : ''),
    row('记录状态', s.paused ? '已暂停' : '记录中', s.paused ? 'warn' : 'ok'),
    row('本地识别', tapText(s.tap), s.tap && s.tap.on ? 'ok' : ''),
    row('录音', recText(s.rec), s.rec && s.rec.on ? 'ok' : ''),
    row('已保存录音', `${savedRecordings} 个文件`),
  ].join('');
  paused = !!s.paused;
  $('#toggleBtn').textContent = paused ? '继续本页' : '暂停本页';
  $('#asrBtn').textContent = s.tap && s.tap.on ? '关闭本地识别' : '开启本地识别';
  $('#recBtn').textContent = s.rec && s.rec.on ? '停止并保存录音' : '开始录音';
  if (flash.until > Date.now()) tip.innerHTML = flash.text;
  else tip.innerHTML = s.framesTotal ? '' : '若“采集帧”一直为 0：请刷新该直播页（扩展需在页面加载前注入），或确认房间正在直播。';
}

function tapText(tap) {
  if (!tap) return '未开启';
  if (tap.on) return `旁听中${tap.pcmChunks ? ` · ${tap.pcmChunks} 块` : ''}`;
  if (tap.reason === 'no-media') return '等播放器出声';
  if (tap.reason === 'bili-asr-on') return '用 B 站 ASR';
  if (tap.reason) return tap.reason.slice(0, 18);
  return '未开启';
}

function recText(rec) {
  if (!rec || !rec.on) return '未开启';
  const sec = Math.max(0, Math.round((Date.now() - (rec.startedAt || Date.now())) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `录音中 ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function refresh() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = tabs[0] || null;
  if (!tab) return render();
  try {
    state = await chrome.tabs.sendMessage(tab.id, { type: 'state' });
  } catch {
    state = null;
  }
  try {
    const r = await chrome.runtime.sendMessage({ type: 'popup-state', tabId: tab.id });
    savedRecordings = r && r.session && r.session.recordings ? r.session.recordings.length : 0;
  } catch {
    savedRecordings = 0;
  }
  render();
}

$('#toggleBtn').addEventListener('click', async () => {
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: paused ? 'resume' : 'pause' });
  } catch {}
  setTimeout(refresh, 150);
});

$('#asrBtn').addEventListener('click', async () => {
  if (!tab) return;
  const on = !!(state && state.tap && state.tap.on);
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: on ? 'local-asr-off' : 'local-asr-on' });
    if (resp && resp.ok === false) {
      flash = { text: '这个房间开了 B 站 ASR，已自动用 B 站转写，无需本地识别。', until: Date.now() + 4000 };
    }
  } catch {}
  setTimeout(refresh, 200);
});

$('#recBtn').addEventListener('click', async () => {
  if (!tab) return;
  const on = !!(state && state.rec && state.rec.on);
  try {
    if (!on) {
      // 先确保离屏文档就绪，否则第一个音频分片可能在文档创建期间丢掉（会导致文件头缺失）
      try {
        await chrome.runtime.sendMessage({ type: 'ensure-offscreen' });
      } catch {}
    }
    await chrome.tabs.sendMessage(tab.id, { type: on ? 'rec-stop' : 'rec-start' });
    flash = {
      text: on ? '录音已停止，文件会保存到浏览器下载目录。' : '开始录音；再点一次停止并保存。',
      until: Date.now() + 4000,
    };
  } catch {}
  setTimeout(refresh, 300);
});

$('#openBtn').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/dashboard.html') });
  window.close();
});

refresh();
setInterval(refresh, 1000);
