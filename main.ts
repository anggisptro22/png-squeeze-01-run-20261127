import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync, constants } from 'node:zlib';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(Uint8Array.from(type, ch => ch.charCodeAt(0)), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function filterImage(samples, width, height, bpp, choose) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    let type = choose;
    if (choose === 'minsum' || choose === 'minsum_paeth') {
      let best = Infinity;
      let isSmooth = false;
      if (choose === 'minsum_paeth') {
        filterRow(0, cur, prev, bpp, trial[0]);
        const s0 = signedSum(trial[0]);
        isSmooth = s0 < stride * 48;
      }
      for (let t = 0; t < 5; t++) {
        if (!(choose === 'minsum_paeth' && t === 0 && isSmooth)) {
          filterRow(t, cur, prev, bpp, trial[t]);
        }
        let s = signedSum(trial[t]);
        if (choose === 'minsum_paeth' && t === 4 && isSmooth) {
          s = Math.floor(s * 0.95);
        }
        if (s < best) {
          best = s;
          type = t;
        }
      }
      raw.set(trial[type], y * (stride + 1) + 1);
    } else {
      filterRow(type, cur, prev, bpp, raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    }
    raw[y * (stride + 1)] = type;
  }
  return raw;
}

function decodePng(bytes) {
  if (!(bytes instanceof Uint8Array)) return { ok: false };
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) return { ok: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let idatDone = false;
  let ended = false;
  while (at < bytes.length) {
    if (ended) return { ok: false };
    if (at + 12 > bytes.length) return { ok: false };
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) return { ok: false };
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return { ok: false };
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (header === null && type !== 'IHDR') return { ok: false };
    if (type !== 'IDAT' && idat.length > 0) idatDone = true;
    if (type === 'IHDR') {
      if (header !== null || len !== 13) return { ok: false };
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], compression: data[10], filter: data[11], interlace: data[12] };
      if (header.width === 0 || header.height === 0 || header.depth !== 8 || header.interlace !== 0) return { ok: false };
    } else if (type === 'PLTE') {
      if (palette !== null || header.colourType !== 3 || idat.length > 0 || len === 0 || len % 3 !== 0 || len > 768) return { ok: false };
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null || idat.length > 0) return { ok: false };
      trns = data;
    } else if (type === 'IDAT') {
      if (idatDone || (header.colourType === 3 && palette === null)) return { ok: false };
      idat.push(data);
    } else if (type === 'IEND') {
      if (len !== 0) return { ok: false };
      ended = true;
    }
  }
  if (!ended || idat.length === 0) return { ok: false };
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  let raw;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch {
    return { ok: false };
  }
  if (raw.length !== expected) return { ok: false };

  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return { ok: false };
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }

  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s]; rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3]; lut[e * 4 + 1] = palette[e * 3 + 1]; lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return { ok: false };
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { ok: true, width, height, colourType, rgba };
}

for (const id of readdirSync(I).sort()) {
  const inBytes = readFileSync(join(I, id, 'image.png'));
  const dec = decodePng(inBytes);
  if (!dec.ok) throw new Error(`Failed to decode ${id}`);
  const { width, height, rgba } = dec;
  const n = width * height;

  const candidates = [];
  candidates.push({ colourType: 6, bpp: 4, samples: rgba, palette: null, trns: null });

  let allOpaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) { allOpaque = false; break; }
  }

  if (allOpaque) {
    const rgb = new Uint8Array(n * 3);
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 4, d += 3) {
      rgb[d] = rgba[s]; rgb[d + 1] = rgba[s + 1]; rgb[d + 2] = rgba[s + 2];
    }
    candidates.push({ colourType: 2, bpp: 3, samples: rgb, palette: null, trns: null });

    let allGrey = true;
    for (let i = 0, s = 0; i < n; i++, s += 4) {
      if (rgba[s] !== rgba[s + 1] || rgba[s] !== rgba[s + 2]) { allGrey = false; break; }
    }
    if (allGrey) {
      const grey = new Uint8Array(n);
      for (let i = 0, s = 0; i < n; i++, s += 4) grey[i] = rgba[s];
      candidates.push({ colourType: 0, bpp: 1, samples: grey, palette: null, trns: null });
    }
  }

  let allGreyAlpha = true;
  for (let i = 0, s = 0; i < n; i++, s += 4) {
    if (rgba[s] !== rgba[s + 1] || rgba[s] !== rgba[s + 2]) { allGreyAlpha = false; break; }
  }
  if (allGreyAlpha && !allOpaque) {
    const ga = new Uint8Array(n * 2);
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 4, d += 2) {
      ga[d] = rgba[s]; ga[d + 1] = rgba[s + 3];
    }
    candidates.push({ colourType: 4, bpp: 2, samples: ga, palette: null, trns: null });
  }

  const colorMap = new Map();
  const paletteColors = [];
  const pixelIndices = new Uint8Array(n);
  let tooManyColors = false;

  for (let i = 0, s = 0; i < n; i++, s += 4) {
    const key = (rgba[s] << 24) | (rgba[s + 1] << 16) | (rgba[s + 2] << 8) | rgba[s + 3];
    let idx = colorMap.get(key);
    if (idx === undefined) {
      if (colorMap.size >= 256) { tooManyColors = true; break; }
      idx = colorMap.size;
      colorMap.set(key, idx);
      paletteColors.push(rgba[s], rgba[s + 1], rgba[s + 2], rgba[s + 3]);
    }
    pixelIndices[i] = idx;
  }

  if (!tooManyColors) {
    const numColors = colorMap.size;
    const plte = new Uint8Array(numColors * 3);
    const trnsArr = [];
    let hasTrans = false;
    for (let i = 0; i < numColors; i++) {
      plte[i * 3] = paletteColors[i * 4];
      plte[i * 3 + 1] = paletteColors[i * 4 + 1];
      plte[i * 3 + 2] = paletteColors[i * 4 + 2];
      const a = paletteColors[i * 4 + 3];
      trnsArr.push(a);
      if (a < 255) hasTrans = true;
    }
    let lastNon255 = -1;
    if (hasTrans) {
      for (let i = trnsArr.length - 1; i >= 0; i--) {
        if (trnsArr[i] < 255) { lastNon255 = i; break; }
      }
    }
    const trns = hasTrans ? new Uint8Array(trnsArr.slice(0, lastNon255 + 1)) : null;
    candidates.push({ colourType: 3, bpp: 1, samples: pixelIndices, palette: plte, trns });
  }

  let bestPng = null;
  let minSize = Infinity;

  const filterChoices = ['minsum', 'minsum_paeth', 0, 1, 2, 3, 4];
  const strategies = [
    constants.Z_DEFAULT_STRATEGY,
    constants.Z_FILTERED,
    constants.Z_HUFFMAN_ONLY,
    constants.Z_RLE,
    constants.Z_FIXED
  ];

  for (const cand of candidates) {
    for (const fc of filterChoices) {
      const raw = filterImage(cand.samples, width, height, cand.bpp, fc);
      for (const strat of strategies) {
        const compressed = deflateSync(raw, { level: 9, memLevel: 9, strategy: strat });
        const chunks = [['IHDR', ihdrOf(width, height, cand.colourType)]];
        if (cand.palette) chunks.push(['PLTE', cand.palette]);
        if (cand.trns) chunks.push(['tRNS', cand.trns]);
        chunks.push(['IDAT', new Uint8Array(compressed)], ['IEND', new Uint8Array(0)]);
        const pngBytes = pngOf(chunks);
        if (pngBytes.length < minSize) {
          minSize = pngBytes.length;
          bestPng = pngBytes;
        }
      }
    }
  }

  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), bestPng);
}
