/**
 * 离屏文档：本地语音识别（SenseVoice + sherpa-onnx wasm）。
 * 接收内容脚本送来的 16kHz 单声道 PCM，按能量分段，逐段识别，再把结果发回 Service Worker。
 */
import { initASRModule, OfflineRecognizer, loadVirtualData } from '../vendor/asr-bundle.js';

const MODEL_BASES = [
  'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/',
  'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/',
];
const MODEL_FILE = 'model.int8.onnx';
const TOKENS_FILE = 'tokens.txt';
const CACHE_NAME = 'bili-asr-model-v1';
const SAMPLE_RATE = 16000;

const SEG = {
  startRms: 0.006,
  endRmsRatio: 0.55,
  silenceMs: 700,
  minSpeechMs: 450,
  maxSegmentMs: 12000,
};

let engine = {
  state: 'idle', // idle | loading | downloading | ready | error
  progress: 0,
  error: '',
  segments: 0,
  lastText: '',
  rooms: 0,
};

const segmenters = new Map(); // roomId -> Segmenter
const recordings = new Map(); // recId -> { chunks, bytes, mime, startedAt, roomId, tabId, title }
let modulePromise = null;
let recognizerPromise = null;
let recognizeChain = Promise.resolve();
const MAX_AUDIO_BYTES = 300 * 1024 * 1024;

function sendStatus() {
  try {
    chrome.runtime.sendMessage({ type: 'asr-engine-status', status: { ...engine } }).catch(() => {});
  } catch {
    /* ignore */
  }
}

function setState(state, extra = {}) {
  engine = { ...engine, ...extra, state };
  sendStatus();
}

function b64ToFloat32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i += 1) out[i] = i16[i] / 32768;
  return out;
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length || 1));
}

class Segmenter {
  constructor(roomId, onSegment) {
    this.roomId = roomId;
    this.onSegment = onSegment;
    this.chunks = [];
    this.count = 0;
    this.speaking = false;
    this.silence = 0;
    this.noise = 0.004;
    this.startAt = 0;
  }

  push(samples, at) {
    const level = rms(samples);
    const open = Math.max(SEG.startRms, this.noise * 2.6);
    if (!this.speaking) {
      this.noise = this.noise * 0.97 + level * 0.03;
      if (level <= open) return;
      this.speaking = true;
      this.chunks = [samples];
      this.count = samples.length;
      this.silence = 0;
      this.startAt = at - (samples.length / SAMPLE_RATE) * 1000;
      return;
    }
    this.chunks.push(samples);
    this.count += samples.length;
    if (level < Math.max(SEG.startRms * 0.6, open * SEG.endRmsRatio)) this.silence += samples.length;
    else this.silence = 0;
    const durMs = (this.count / SAMPLE_RATE) * 1000;
    if (this.silence >= (SEG.silenceMs / 1000) * SAMPLE_RATE || durMs >= SEG.maxSegmentMs) {
      this.flush(at);
    }
  }

  flush(at) {
    const chunks = this.chunks;
    const count = this.count;
    this.chunks = [];
    this.count = 0;
    this.speaking = false;
    this.silence = 0;
    const durMs = (count / SAMPLE_RATE) * 1000;
    if (durMs < SEG.minSpeechMs) return;
    const merged = new Float32Array(count);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    this.onSegment({ samples: merged, startAt: this.startAt, endAt: at });
  }

  close() {
    this.chunks = [];
    this.count = 0;
    this.speaking = false;
  }
}

async function fetchWithCache(file, onProgress) {
  const cache = await caches.open(CACHE_NAME).catch(() => null);
  for (const base of MODEL_BASES) {
    const url = base + file;
    try {
      if (cache) {
        const hit = await cache.match(url);
        if (hit) {
          onProgress && onProgress(1);
          return await hit.arrayBuffer();
        }
      }
      const ctrl = new AbortController();
      let timer = setTimeout(() => ctrl.abort(), 20000); // 20 秒还没开始出数据就换镜像
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      let buf;
      if (res.body && total > 0) {
        buf = new Uint8Array(total);
        const reader = res.body.getReader();
        let off = 0;
        let lastData = Date.now();
        timer = setInterval(() => {
          if (Date.now() - lastData > 20000) {
            try {
              ctrl.abort();
            } catch {}
          }
        }, 5000);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            lastData = Date.now();
            if (off + value.length > buf.length) {
              const grown = new Uint8Array(off + value.length);
              grown.set(buf.subarray(0, off));
              grown.set(value, off);
              buf = grown;
            } else {
              buf.set(value, off);
            }
            off += value.length;
            if (onProgress && total) onProgress(Math.min(0.99, off / total));
          }
        } finally {
          clearInterval(timer);
        }
        buf = buf.subarray(0, off);
      } else {
        buf = new Uint8Array(await res.arrayBuffer());
      }
      if (cache) {
        try {
          await cache.put(url, new Response(buf.slice(0)));
        } catch (e) {
          console.warn('cache.put failed', e);
        }
      }
      onProgress && onProgress(1);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch (e) {
      console.warn('model fetch failed', url, e && e.message);
      lastFetchError = String((e && e.message) || e);
    }
  }
  throw new Error(lastFetchError || '模型下载失败');
}
let lastFetchError = '';

async function ensureEngine() {
  if (!recognizerPromise) {
    recognizerPromise = (async () => {
      setState('loading', { progress: 0 });
      modulePromise = initASRModule();
      const module = await modulePromise;
      setState('downloading', { progress: 0 });
      const modelBuf = await fetchWithCache(MODEL_FILE, (p) => {
        engine = { ...engine, state: 'downloading', progress: Math.round(p * 100) };
        if (engine.progress % 5 === 0 || engine.progress >= 100) sendStatus();
      });
      const tokens = await fetchWithCache(TOKENS_FILE);
      const tokensText = new TextDecoder().decode(tokens);
      loadVirtualData({
        module,
        parent: '/',
        virtualData: { [MODEL_FILE]: modelBuf, [TOKENS_FILE]: tokensText },
      });
      const recognizer = new OfflineRecognizer(
        {
          featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
          modelConfig: {
            senseVoice: { model: '/' + MODEL_FILE, language: 'zh', useInverseTextNormalization: 1 },
            tokens: '/' + TOKENS_FILE,
            numThreads: 1,
            provider: 'cpu',
            debug: 0,
          },
        },
        module,
      );
      setState('ready', { progress: 100, error: '' });
      return recognizer;
    })().catch((e) => {
      setState('error', { error: String((e && e.message) || e) });
      recognizerPromise = null;
      throw e;
    });
  }
  return recognizerPromise;
}

function recognize(seg) {
  recognizeChain = recognizeChain.then(async () => {
    const recognizer = await ensureEngine();
    const stream = recognizer.createStream();
    stream.acceptWaveform(SAMPLE_RATE, seg.samples);
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    try {
      stream.free();
    } catch {
      /* ignore */
    }
    const text = String((result && result.text) || '')
      .replace(/<\|[^|]*\|>/g, '')
      .trim();
    if (!text) return;
    engine = { ...engine, segments: engine.segments + 1, lastText: text };
    sendStatus();
    chrome.runtime
      .sendMessage({
        type: 'local-asr',
        roomId: seg.roomId,
        startAt: Math.round(seg.startAt),
        endAt: Math.round(seg.endAt),
        text,
        engine: 'sensevoice',
      })
      .catch(() => {});
  }).catch((e) => {
    console.warn('recognize failed', e);
  });
}

function getSegmenter(roomId) {
  let seg = segmenters.get(roomId);
  if (!seg) {
    seg = new Segmenter(roomId, (s) => recognize({ ...s, roomId }));
    segmenters.set(roomId, seg);
    engine = { ...engine, rooms: segmenters.size };
  }
  return seg;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function finalizeRecording(recId, meta = {}) {
  const item = recordings.get(recId);
  if (!item) return;
  recordings.delete(recId);
  const parts = Array.from(item.parts.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  if (!parts.length) {
    chrome.runtime.sendMessage({ type: 'audio-empty', recId, roomId: item.roomId }).catch(() => {});
    return;
  }
  const blob = new Blob(parts, { type: item.mime || 'audio/webm' });
  const startedAt = meta.startedAt || item.startedAt;
  const stoppedAt = meta.stoppedAt || Date.now();
  // MediaRecorder 产出的 WebM 没有时长元数据，补一下，播放器/播放条才正常
  let outBlob = blob;
  try {
    const fix = globalThis.ysFixWebmDuration;
    if (typeof fix === 'function') {
      const fixed = await fix(blob, Math.max(1000, stoppedAt - startedAt), { logger: false });
      if (fixed && fixed.size) outBlob = fixed;
    }
  } catch (e) {
    console.warn('fix webm duration failed, keep original', e);
  }
  const url = URL.createObjectURL(outBlob);
  let head = '';
  const heads = [];
  try {
    const first = new Uint8Array(await outBlob.slice(0, 8).arrayBuffer());
    head = Array.from(first).map((x) => x.toString(16).padStart(2, '0')).join(' ');
  } catch {}
  chrome.runtime
    .sendMessage({
      type: 'audio-ready',
      recId,
      roomId: item.roomId,
      tabId: item.tabId,
      url,
      size: outBlob.size,
      head,
      heads,
      partsCount: parts.length,
      mime: item.mime || 'audio/webm',
      startedAt,
      stoppedAt,
      durationMs: Math.max(0, stoppedAt - startedAt),
      title: meta.title || item.title || '',
    })
    .catch(() => {});
  // 让 Blob URL 多活一会儿，等下载真正开始
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }, 5 * 60 * 1000);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'pcm') {
    if (!sender || !sender.tab) return; // 只收内容脚本的音频
    try {
      const f32 = b64ToFloat32(msg.b64);
      if (!f32.length) return;
      getSegmenter(String(msg.roomId || '')).push(f32, msg.at || Date.now());
      if (engine.state === 'idle') ensureEngine().catch(() => {});
    } catch (e) {
      console.warn('pcm error', e);
    }
    sendResponse({ ok: true });
  } else if (msg.type === 'audio-chunk') {
    if (!sender || !sender.tab) return;
    const recId = String(msg.recId || '');
    if (!recId) return;
    let item = recordings.get(recId);
    if (!item) {
      item = { parts: new Map(), bytes: 0, mime: msg.mime || 'audio/webm', startedAt: msg.at || Date.now(), roomId: String(msg.roomId || ''), tabId: sender.tab.id, title: '' };
      recordings.set(recId, item);
    }
    try {
      const bytes = b64ToBytes(msg.b64);
      if (item.bytes + bytes.length > MAX_AUDIO_BYTES) {
        console.warn('recording too big, stop buffering', recId);
      } else {
        item.parts.set(Number(msg.seq) || item.parts.size + 1, bytes);
        item.bytes += bytes.length;
      }
    } catch (e) {
      console.warn('audio chunk error', e);
    }
    sendResponse({ ok: true });
  } else if (msg.type === 'audio-stop') {
    finalizeRecording(String(msg.recId || ''), msg);
    sendResponse({ ok: true });
  } else if (msg.type === 'audio-finalize-room') {
    // 标签页关闭时兜底：把这个房间/标签页还没落盘的录音收尾
    for (const [recId, item] of Array.from(recordings.entries())) {
      if ((msg.tabId && item.tabId === msg.tabId) || (msg.roomId && item.roomId === String(msg.roomId))) {
        finalizeRecording(recId, { title: msg.title });
      }
    }
    sendResponse({ ok: true });
  } else if (msg.type === 'asr-status-request') {
    sendResponse({ ok: true, status: { ...engine } });
  } else if (msg.type === 'asr-warmup') {
    ensureEngine().catch(() => {});
    sendResponse({ ok: true });
  } else if (msg.type === 'asr-reset') {
    for (const s of segmenters.values()) s.close();
    segmenters.clear();
    engine = { ...engine, rooms: 0 };
    sendStatus();
    sendResponse({ ok: true });
  }
  return true;
});

sendStatus();

