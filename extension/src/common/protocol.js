/**
 * B 站直播弹幕协议解析（纯函数，可在浏览器 / Service Worker / Node 中复用）。
 *
 * 包结构（大端）：
 *   0-3  uint32 packetLen  整包长度（含 16 字节头）
 *   4-5  uint16 headerLen  头长度，固定 16
 *   6-7  uint16 ver        0=明文 1=心跳/认证 2=zlib 3=brotli
 *   8-11 uint32 op         2=心跳 3=心跳回复 5=普通消息 7=认证 8=认证回复
 *   12-15 uint32 seq
 */

export const OP = Object.freeze({
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  MESSAGE: 5,
  AUTH: 7,
  AUTH_REPLY: 8,
});

const textDecoder = new TextDecoder('utf-8');

function safeJson(bytes) {
  try {
    const s = textDecoder.decode(bytes);
    if (!s) return null;
    // 心跳回复等不是 JSON，直接忽略
    const c = s.charCodeAt(0);
    if (c !== 123 && c !== 91) return null; // '{' or '['
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** 把一段字节切成若干包头，返回 [{ver, op, body}]（body 为 Uint8Array 视图）。 */
export function splitPackets(buf) {
  const out = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;
  while (off + 16 <= buf.length) {
    const packetLen = view.getUint32(off);
    const headerLen = view.getUint16(off + 4);
    const ver = view.getUint16(off + 6);
    const op = view.getUint32(off + 8);
    if (packetLen < 16 || headerLen < 16 || off + packetLen > buf.length) break;
    out.push({ ver, op, body: buf.subarray(off + headerLen, off + packetLen) });
    off += packetLen;
  }
  return out;
}

/**
 * 解码一整帧（可能嵌套压缩）。
 * @param {Uint8Array} bytes
 * @param {(b: Uint8Array) => (Uint8Array|Promise<Uint8Array>)} brotli  brotli 解压实现
 * @param {(b: Uint8Array) => (Uint8Array|Promise<Uint8Array>)} inflate zlib 解压实现（默认用 DecompressionStream）
 * @returns {Promise<Array<{op:number, ver:number, json:any}>>}
 */
export async function decodeFrame(bytes, brotli, inflate = defaultInflate) {
  const result = [];
  const stack = [bytes];
  let guard = 0;
  while (stack.length) {
    if (++guard > 64) break;
    const buf = stack.pop();
    for (const pkt of splitPackets(buf)) {
      if (pkt.op === OP.MESSAGE) {
        if (pkt.ver === 2) {
          stack.push(await inflate(pkt.body));
        } else if (pkt.ver === 3) {
          stack.push(await brotli(pkt.body));
        } else if (pkt.body.length) {
          const json = safeJson(pkt.body);
          if (json) result.push({ op: pkt.op, ver: pkt.ver, json });
        }
      } else if (pkt.op === OP.AUTH_REPLY || pkt.op === OP.AUTH) {
        const json = safeJson(pkt.body);
        if (json) result.push({ op: pkt.op, ver: pkt.ver, json });
      } else if (pkt.op === OP.HEARTBEAT_REPLY) {
        const popularity = pkt.body.length >= 4 ? new DataView(pkt.body.buffer, pkt.body.byteOffset, 4).getUint32(0) : 0;
        result.push({ op: pkt.op, ver: pkt.ver, popularity });
      }
    }
  }
  return result;
}

async function defaultInflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 组装一个上行包（测试/独立连接时用）。 */
export function buildPacket(op, body, { ver = 1, seq = 1 } = {}) {
  const payload = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const out = new Uint8Array(16 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  view.setUint16(4, 16);
  view.setUint16(6, ver);
  view.setUint32(8, op);
  view.setUint32(12, seq);
  out.set(payload, 16);
  return out;
}

/** 从认证包里取真实房间号（hook 用它给帧打上房间标记）。 */
export function roomIdFromAuth(json) {
  const id = Number(json && (json.roomid || json.room_id));
  return Number.isFinite(id) && id > 0 ? id : 0;
}
