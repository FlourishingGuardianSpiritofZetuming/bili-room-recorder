/**
 * WBI 签名（B 站 2023 年起对 web 接口加的 w_rid 校验）。
 *
 * 以「经典脚本」形式提供，挂到 globalThis.BiliWbi 上：
 *   - 内容脚本（content_scripts）无法使用 ESM，只能按顺序加载经典脚本；
 *   - 这样 Node 测试也能直接 eval 这个文件来验证签名。
 */
(function (root) {
  'use strict';

  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
    26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
    20, 34, 44, 52,
  ];

  const SHIFT = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;

  /** 标准 MD5，返回 32 位小写十六进制字符串。 */
  function md5(input) {
    const msg = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const bitLen = msg.length * 8;
    const total = (((msg.length + 8) >> 6) + 1) << 6;
    const buf = new Uint8Array(total);
    buf.set(msg);
    buf[msg.length] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, bitLen >>> 0, true);
    dv.setUint32(total - 4, Math.floor(bitLen / 0x100000000), true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    const m = new Uint32Array(16);

    for (let off = 0; off < total; off += 64) {
      for (let j = 0; j < 16; j += 1) m[j] = dv.getUint32(off + j * 4, true);
      let A = a0;
      let B = b0;
      let C = c0;
      let D = d0;
      for (let i = 0; i < 64; i += 1) {
        let F;
        let g;
        if (i < 16) {
          F = (B & C) | (~B & D);
          g = i;
        } else if (i < 32) {
          F = (D & B) | (~D & C);
          g = (5 * i + 1) % 16;
        } else if (i < 48) {
          F = B ^ C ^ D;
          g = (3 * i + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = (7 * i) % 16;
        }
        F = (F + A + K[i] + m[g]) >>> 0;
        A = D;
        D = C;
        C = B;
        B = (B + (((F << SHIFT[i]) | (F >>> (32 - SHIFT[i]))) >>> 0)) >>> 0;
      }
      a0 = (a0 + A) >>> 0;
      b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0;
      d0 = (d0 + D) >>> 0;
    }

    const out = new DataView(new ArrayBuffer(16));
    out.setUint32(0, a0, true);
    out.setUint32(4, b0, true);
    out.setUint32(8, c0, true);
    out.setUint32(12, d0, true);
    let hex = '';
    for (let i = 0; i < 16; i += 1) hex += out.getUint8(i).toString(16).padStart(2, '0');
    return hex;
  }

  function extractWbiKeys(navJson) {
    const img = navJson && navJson.data && navJson.data.wbi_img;
    if (!img || !img.img_url || !img.sub_url) return null;
    const pick = (u) => String(u).split('/').pop().split('.')[0];
    return [pick(img.img_url), pick(img.sub_url)];
  }

  function mixinKey(imgKey, subKey) {
    const raw = String(imgKey) + String(subKey);
    let out = '';
    for (let i = 0; i < 32; i += 1) out += raw[MIXIN_KEY_ENC_TAB[i]] || '';
    return out;
  }

  function signParams(params, imgKey, subKey, nowSec) {
    const wts = nowSec || Math.floor(Date.now() / 1000);
    const mk = mixinKey(imgKey, subKey);
    const all = Object.assign({}, params, { wts: wts });
    const query = Object.keys(all)
      .sort()
      .map(function (k) {
        const v = String(all[k] == null ? '' : all[k]).replace(/[!'()*]/g, '');
        return encodeURIComponent(k) + '=' + encodeURIComponent(v);
      })
      .join('&');
    return query + '&w_rid=' + md5(query + mk);
  }

  root.BiliWbi = { md5: md5, extractWbiKeys: extractWbiKeys, mixinKey: mixinKey, signParams: signParams };
})(typeof globalThis !== 'undefined' ? globalThis : this);
