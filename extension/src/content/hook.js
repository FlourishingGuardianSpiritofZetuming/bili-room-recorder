/**
 * 页面主世界（MAIN world）脚本：包一层 WebSocket，把 B 站弹幕连接收到的原始帧
 * 用 postMessage 交给隔离世界的 bridge.js。
 *
 * 只做「透传 + 轻量头解析」，不解压、不改页面行为。
 */
(() => {
  const FLAG = '__biliRoomRecorderHooked__';
  if (window[FLAG]) return;
  Object.defineProperty(window, FLAG, { value: true, enumerable: false });

  const Native = window.WebSocket;
  if (typeof Native !== 'function') return;

  const MAX_FRAME = 1024 * 1024;
  let frameCount = 0;

  const post = (msg) => {
    try {
      window.postMessage({ __biliRec: 1, ...msg }, '*');
    } catch {
      /* 忽略结构化克隆失败 */
    }
  };

  function toBase64(bytes) {
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(out);
  }

  function isDanmakuUrl(url) {
    try {
      const u = new URL(url, location.href);
      if (!/bilibili\.com$/.test(u.hostname) && !/bilibili\.com:/.test(u.host + ':')) {
        if (!/bilibili\.com/.test(u.hostname)) return false;
      }
      return /chat\.bilibili\.com/.test(u.hostname) || /\/sub$/.test(u.pathname) || /broadcastlv/.test(u.hostname);
    } catch {
      return false;
    }
  }

  function hookSocket(ws, url) {
    ws.addEventListener('message', async (ev) => {
      try {
        let buf = null;
        const data = ev.data;
        if (data instanceof ArrayBuffer) {
          buf = new Uint8Array(data);
        } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
          if (data.size > MAX_FRAME) return;
          buf = new Uint8Array(await data.arrayBuffer());
        } else {
          return;
        }
        if (!buf || buf.length < 16) return;
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const packetLen = dv.getUint32(0);
        const ver = dv.getUint16(6);
        const op = dv.getUint32(8);
        if (packetLen < 16 || packetLen > buf.length) return;
        if (op !== 5 && op !== 8) return; // 只关心业务消息 / 认证回复，跳过心跳
        frameCount += 1;
        post({ type: 'frame', url, op, ver, recvAt: Date.now(), b64: toBase64(buf) });
      } catch {
        /* 单帧失败不影响后续 */
      }
    });
  }

  function Wrapped(url, protocols) {
    if (!new.target) throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator.");
    const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    try {
      if (isDanmakuUrl(String(url))) hookSocket(ws, String(url));
    } catch {
      /* hook 失败时页面照常工作 */
    }
    return ws;
  }

  Wrapped.prototype = Native.prototype;
  Object.setPrototypeOf(Wrapped, Native);
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    try {
      Object.defineProperty(Wrapped, k, { value: Native[k], enumerable: true });
    } catch {
      /* ignore */
    }
  }
  try {
    Object.defineProperty(Wrapped, 'name', { value: 'WebSocket' });
  } catch {
    /* ignore */
  }

  window.WebSocket = Wrapped;

  // ---- 抓取首屏 SSR 里的房间/麦位快照（页面自带 __NEPTUNE_IS_MY_WAIFU__，不用额外请求） ----
  function readSeed() {
    const w = window.__NEPTUNE_IS_MY_WAIFU__;
    const d = w && w.roomInfoRes && w.roomInfoRes.data;
    if (!d || !d.room_info) return null;
    const r = d.room_info;
    const a = d.anchor_info && d.anchor_info.base_info;
    const ui = d.universal_interact_info_v2 || d.universal_interact_info;
    const seats = ((ui && ui.members) || []).map((m) => {
      const mv = m.biz_extra_data && m.biz_extra_data.multi_voice;
      return {
        uid: String(m.uid == null ? '' : m.uid),
        name: m.uname || m.display_name || '',
        position: typeof m.position === 'number' ? m.position : -1,
        joinTime: (m.join_time || 0) * 1000,
        mute: !!(mv && Number(mv.is_mute) === 1),
        role: (mv && mv.role) || 0,
      };
    });
    if (!seats.length && d.voice_join_info && d.voice_join_info.status && d.voice_join_info.status.uid) {
      const s = d.voice_join_info.status;
      seats.push({
        uid: String(s.uid),
        name: s.user_name || '',
        position: 0,
        joinTime: (s.start_at || 0) * 1000,
        mute: false,
        role: 0,
        single: true,
      });
    }
    return {
      room: {
        roomId: String(r.room_id == null ? '' : r.room_id),
        title: r.title || '',
        anchor: (a && a.uname) || '',
        anchorUid: String((a && a.uid) || ''),
        area: r.area_name || '',
        parentArea: r.parent_area_name || '',
        cover: r.cover || '',
        liveStatus: r.live_status || 0,
        online: r.online || 0,
        asrEnabled: (() => {
          const mv = d.multi_voice && typeof d.multi_voice.enable_asr === 'boolean' ? d.multi_voice.enable_asr : null;
          if (mv !== null) return mv;
          const first = (ui && ui.members && ui.members[0]) || null;
          const mvm = first && first.biz_extra_data && first.biz_extra_data.multi_voice;
          return mvm ? !!mvm.enable_asr : null;
        })(),
      },
      seats,
      bizSessionId: (ui && ui.biz_session_id) || '',
    };
  }

  let seedSent = false;
  function trySeed() {
    if (seedSent) return;
    const seed = readSeed();
    if (!seed) return;
    seedSent = true;
    post({ type: 'seed', seed });
  }
  // DOMContentLoaded / load 时立即读一次（后台标签页的定时器会被节流，事件不会）
  document.addEventListener('DOMContentLoaded', trySeed, { once: true });
  window.addEventListener('load', trySeed, { once: true });
  const seedTimer = setInterval(trySeed, 400);
  const seedStop = setInterval(() => {
    if (seedSent) {
      clearInterval(seedTimer);
      clearInterval(seedStop);
    }
  }, 1000);
  setTimeout(() => {
    clearInterval(seedTimer);
    clearInterval(seedStop);
  }, 20000);

  // 让 bridge 知道 hook 是否装上了
  post({ type: 'hooked' });
  setInterval(() => {
    if (frameCount > 0) {
      post({ type: 'hook-stats', frameCount });
      frameCount = 0;
    }
  }, 10000);

  // ================= 音频旁听：本地识别 PCM + 可选录音 =================
  // 语聊房的播放器是一个 <video>（音频混在一条音轨里），用 WebAudio 直接取声音，
  // 不需要 tabCapture，也不需要用户授权。后台标签页只要还在放声音就持续有数据。
  const AC = window.AudioContext || window.webkitAudioContext;
  const sourceMap = new WeakMap();
  let graph = null; // { el, ctx, src, own, sink }
  let tap = null;
  let tapWanted = false;
  let rec = null; // { recId, el, ctx, src, mr, dest, mime, startedAt, seq, stopping, stopped, pending }
  let recWanted = false;

  if (AC && !AC.prototype.__biliRecPatched) {
    const origCreate = AC.prototype.createMediaElementSource;
    AC.prototype.createMediaElementSource = function (el) {
      const node = origCreate.apply(this, arguments);
      try {
        sourceMap.set(el, { ctx: this, node });
      } catch {
        /* ignore */
      }
      return node;
    };
    try {
      AC.prototype.__biliRecPatched = true;
    } catch {
      /* ignore */
    }
  }

  function pickMedia() {
    const list = Array.from(document.querySelectorAll('video,audio'));
    let best = null;
    for (const el of list) {
      if (el.paused || el.readyState < 2 || el.muted) continue;
      if (!best) best = el;
      else if (el.currentTime > 0 && !(best.currentTime > 0)) best = el;
    }
    return best;
  }

  /** 统一音频图：同一时刻只对一个媒体元素建一次 MediaElementSource（Chrome 限制）。 */
  function ensureGraph(el) {
    if (graph && graph.el === el && graph.ctx.state !== 'closed') {
      if (graph.ctx.state === 'suspended') graph.ctx.resume().catch(() => {});
      return graph;
    }
    if (graph) {
      try {
        graph.sink && graph.sink.disconnect();
      } catch {
        /* ignore */
      }
      graph = null;
    }
    const known = sourceMap.get(el);
    if (known) {
      graph = { el, ctx: known.ctx, src: known.node, own: false, sink: null };
    } else {
      try {
        const ctx = new AC();
        const src = ctx.createMediaElementSource(el);
        sourceMap.set(el, { ctx, node: src });
        // 自建 context 必须接回扬声器，否则页面会没声音
        const sink = ctx.createGain();
        sink.gain.value = 1;
        src.connect(sink);
        sink.connect(ctx.destination);
        graph = { el, ctx, src, own: true, sink };
      } catch (e) {
        post({ type: 'tap-status', ok: false, reason: 'source-failed: ' + (e && e.message) });
        return null;
      }
    }
    if (graph.ctx.state === 'suspended') graph.ctx.resume().catch(() => {});
    return graph;
  }

  function downsample(input, from, to) {
    if (from === to) return input;
    const ratio = from / to;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += input[j];
      out[i] = end > start ? sum / (end - start) : 0;
    }
    return out;
  }

  // ---------- 本地识别：16kHz PCM ----------
  function startTap() {
    tapWanted = true;
    if (!AC) {
      post({ type: 'tap-status', ok: false, reason: 'no-webaudio' });
      return;
    }
    const el = pickMedia();
    if (!el) {
      post({ type: 'tap-status', ok: false, reason: 'no-media' });
      return;
    }
    const g = ensureGraph(el);
    if (!g) return;
    if (tap && tap.el === el && tap.ctx === g.ctx) return;
    stopTap(false, true);

    let proc;
    try {
      proc = g.ctx.createScriptProcessor(4096, 1, 1);
    } catch (e) {
      post({ type: 'tap-status', ok: false, reason: 'processor-failed' });
      return;
    }
    const mute = g.ctx.createGain();
    mute.gain.value = 0;
    g.src.connect(proc);
    proc.connect(mute);
    mute.connect(g.ctx.destination);

    proc.onaudioprocess = (ev) => {
      if (!tapWanted || !tap) return;
      try {
        const input = ev.inputBuffer.getChannelData(0);
        const res = g.ctx.sampleRate === 16000 ? input : downsample(input, g.ctx.sampleRate, 16000);
        const pcm = new Int16Array(res.length);
        for (let i = 0; i < res.length; i += 1) {
          const v = Math.max(-1, Math.min(1, res[i]));
          pcm[i] = v < 0 ? v * 32768 : v * 32767;
        }
        tap.sent = (tap.sent || 0) + 1;
        post({ type: 'pcm', at: Date.now(), rate: 16000, b64: toBase64(new Uint8Array(pcm.buffer)) });
      } catch (e) {
        tap.err = String((e && e.message) || e);
        post({ type: 'tap-status', ok: true, error: tap.err });
      }
    };

    tap = { el, ctx: g.ctx, src: g.src, proc, mute, alive: true, sent: 0, err: '', startedAt: Date.now() };
    post({ type: 'tap-status', ok: true, sampleRate: g.ctx.sampleRate, state: g.ctx.state });
  }

  function stopTap(notify = true, keepWanted = false) {
    if (!keepWanted) tapWanted = false;
    if (tap) {
      try {
        tap.proc.disconnect();
      } catch {}
      try {
        tap.mute.disconnect();
      } catch {}
      try {
        tap.src.disconnect(tap.proc);
      } catch {}
      tap = null;
    }
    if (notify) post({ type: 'tap-status', ok: false, reason: 'stopped' });
  }

  // ---------- 可选录音：Opus / WebM ----------
  let recSeq = 0;

  function startRecorder() {
    recWanted = true;
    if (!AC || typeof MediaRecorder === 'undefined') {
      post({ type: 'rec-status', on: false, reason: 'unsupported' });
      return;
    }
    const el = pickMedia();
    if (!el) {
      post({ type: 'rec-status', on: false, reason: 'no-media' });
      return;
    }
    const g = ensureGraph(el);
    if (!g) return;
    if (rec && rec.el === el && rec.startedAt) return;
    stopRecorder(false);

    let dest;
    let mr;
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    try {
      dest = g.ctx.createMediaStreamDestination();
      g.src.connect(dest);
      mr = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 48000 });
    } catch (e) {
      post({ type: 'rec-status', on: false, reason: 'recorder-failed: ' + (e && e.message) });
      return;
    }

    recSeq += 1;
    const state = {
      recId: `${Date.now()}-${recSeq}`,
      el,
      ctx: g.ctx,
      src: g.src,
      dest,
      mr,
      mime,
      startedAt: Date.now(),
      seq: 0,
      pending: 0,
      stopping: false,
      stopped: false,
      done: false,
    };
    rec = state;

    const finish = () => {
      if (!state.stopping || !state.stopped || state.pending > 0 || state.done) return;
      state.done = true;
      if (rec === state) rec = null;
      try {
        state.src.disconnect(state.dest);
      } catch {}
      post({ type: 'audio-stop', recId: state.recId, startedAt: state.startedAt, stoppedAt: Date.now(), mime: state.mime });
    };

    // 每个 Blob 的 arrayBuffer() 都是异步的，必须串行发送，否则分片会乱序、文件损坏
    let chain = Promise.resolve();
    mr.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return;
      state.pending += 1;
      chain = chain
        .then(async () => {
          const buf = await ev.data.arrayBuffer();
          state.seq += 1;
          const bytes = new Uint8Array(buf);
          try {
            window.__biliLastAudio = {
              seq: state.seq,
              len: bytes.length,
              head: Array.from(bytes.slice(0, 8))
                .map((x) => x.toString(16).padStart(2, '0'))
                .join(' '),
              type: ev.data.type,
              chunkSize: ev.data.size,
              mime: state.mime,
            };
          } catch {}
          post({
            type: 'audio-chunk',
            recId: state.recId,
            seq: state.seq,
            at: Date.now(),
            mime: state.mime,
            b64: toBase64(bytes),
          });
        })
        .catch(() => {})
        .finally(() => {
          state.pending -= 1;
          finish();
        });
    };
    mr.onstop = () => {
      state.stopped = true;
      finish();
    };

    try {
      mr.start(5000);
    } catch (e) {
      post({ type: 'rec-status', on: false, reason: 'start-failed: ' + (e && e.message) });
      return;
    }
    post({ type: 'rec-status', on: true, recId: state.recId, mime: state.mime, startedAt: state.startedAt, sampleRate: g.ctx.sampleRate });
  }

  function stopRecorder(notify = true) {
    recWanted = false;
    const state = rec;
    if (state) {
      state.stopping = true;
      try {
        state.mr.stop();
      } catch {}
    }
    if (notify) post({ type: 'rec-status', on: false, reason: 'stopped' });
  }

  // ---------- 指令 ----------
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__biliRec !== 1) return;
    if (d.type === 'tap-start') startTap();
    else if (d.type === 'tap-stop') stopTap();
    else if (d.type === 'rec-start') startRecorder();
    else if (d.type === 'rec-stop') stopRecorder();
  });

  // 播放器可能被替换 / 暂停后恢复，定时检查
  setInterval(() => {
    if (!tapWanted && !recWanted) return;
    const el = pickMedia();
    if (!el) {
      if (tap) stopTap(true);
      return;
    }
    if (tapWanted && (!tap || tap.el !== el)) startTap();
    else if (tap && tap.ctx.state === 'suspended') tap.ctx.resume().catch(() => {});
    if (recWanted && rec && rec.el !== el) {
      stopRecorder(false);
      startRecorder();
    }
  }, 3000);

  // 状态心跳，便于面板/弹窗排查
  setInterval(() => {
    if (tap) {
      post({
        type: 'tap-status',
        ok: true,
        state: tap.ctx.state,
        sent: tap.sent || 0,
        error: tap.err || '',
        sampleRate: tap.ctx.sampleRate,
        media: {
          tag: tap.el.tagName,
          paused: tap.el.paused,
          ready: tap.el.readyState,
          volume: tap.el.volume,
          muted: tap.el.muted,
        },
      });
    }
    if (rec) {
      post({
        type: 'rec-status',
        on: true,
        recId: rec.recId,
        startedAt: rec.startedAt,
        chunks: rec.seq,
        state: rec.mr.state,
        mime: rec.mime,
      });
    }
  }, 5000);
})();


