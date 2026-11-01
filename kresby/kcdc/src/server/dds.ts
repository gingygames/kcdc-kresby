// Textura kresby jako DDS hry: BC1 (DXT1) sRGB s celou řadou mipmap, rozdělená do souborů stejně jako textury KCD2
// (`x_diff.dds` = hlavička + nejmenší mipmapy, `x_diff.dds.1` … `.N` = větší mipmapy, `.N` největší). Hlavička kopíruje
// pole, která hra zapisuje do svých textur (CryEngine: průměrný jas, rozsah barev, značka `FYRC`, DX10 s formátem
// BC1_UNORM_SRGB = 72). Zjištěno z textur hry (Objects/.../scroll_diff.dds), viz AGENTS.md.

import { Budget, f32, release, runSync, type Canvas } from "./raster";

export interface DdsFiles {
  /** přípona -> bajty: "" = .dds, "1" = .dds.1, … */
  files: Map<string, Uint8Array>;
  w: number;
  h: number;
  mips: number;
  bytes: number;
}

const BC1_SRGB = 72;

// ---------------------------------------------------------------------------
// BC1 kodér (rozsah podél hlavní osy barev bloku, 4 barvy)

const to565 = (r: number, g: number, b: number) => ((Math.round(r * 31 / 255) << 11) | (Math.round(g * 63 / 255) << 5) | Math.round(b * 31 / 255)) >>> 0;
const from565 = (c: number): [number, number, number] => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];

// pracovní pole bloku: jedno pro všechny bloky (dřív nové pole a paleta pro každý blok 4×4)
const px = new Float32Array(48);
const pal = new Float32Array(12);
const e565 = (c: number, o: number) => {
  pal[o] = (((c >> 11) & 31) * 255) / 31;
  pal[o + 1] = (((c >> 5) & 63) * 255) / 63;
  pal[o + 2] = ((c & 31) * 255) / 31;
};

function encodeBlock(src: Float32Array, w: number, h: number, bx: number, by: number, out: Uint8Array, o: number) {
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const x = Math.min(w - 1, bx + i);
      const y = Math.min(h - 1, by + j);
      const s = (y * w + x) * 3;
      const d = (j * 4 + i) * 3;
      px[d] = src[s];
      px[d + 1] = src[s + 1];
      px[d + 2] = src[s + 2];
      mr += src[s];
      mg += src[s + 1];
      mb += src[s + 2];
    }
  }
  mr /= 16;
  mg /= 16;
  mb /= 16;
  // kovariance a hlavní osa (mocninná metoda)
  let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
  for (let k = 0; k < 16; k++) {
    const r = px[k * 3] - mr;
    const g = px[k * 3 + 1] - mg;
    const b = px[k * 3 + 2] - mb;
    c00 += r * r; c01 += r * g; c02 += r * b; c11 += g * g; c12 += g * b; c22 += b * b;
  }
  let ax = 0.577, ay = 0.577, az = 0.577;
  for (let it = 0; it < 6; it++) {
    const nx = c00 * ax + c01 * ay + c02 * az;
    const ny = c01 * ax + c11 * ay + c12 * az;
    const nz = c02 * ax + c12 * ay + c22 * az;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-6) break;
    ax = nx / l; ay = ny / l; az = nz / l;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < 16; k++) {
    const t = (px[k * 3] - mr) * ax + (px[k * 3 + 1] - mg) * ay + (px[k * 3 + 2] - mb) * az;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  const inset = (hi - lo) / 32;
  lo += inset;
  hi -= inset;
  const cl = (v: number) => Math.max(0, Math.min(255, v));
  let c0 = to565(cl(mr + ax * hi), cl(mg + ay * hi), cl(mb + az * hi));
  let c1 = to565(cl(mr + ax * lo), cl(mg + ay * lo), cl(mb + az * lo));
  if (c0 < c1) [c0, c1] = [c1, c0];
  let idx = 0;
  if (c0 !== c1) {
    e565(c0, 0);
    e565(c1, 3);
    for (let i = 0; i < 3; i++) {
      pal[6 + i] = (2 * pal[i] + pal[3 + i]) / 3;
      pal[9 + i] = (pal[i] + 2 * pal[3 + i]) / 3;
    }
    for (let k = 15; k >= 0; k--) {
      let best = 0;
      let bd = Infinity;
      for (let q = 0; q < 4; q++) {
        const dr = px[k * 3] - pal[q * 3];
        const dg = px[k * 3 + 1] - pal[q * 3 + 1];
        const db = px[k * 3 + 2] - pal[q * 3 + 2];
        const dd = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
        if (dd < bd) (bd = dd), (best = q);
      }
      idx = ((idx << 2) | best) >>> 0;
    }
  }
  out[o] = c0 & 255;
  out[o + 1] = c0 >> 8;
  out[o + 2] = c1 & 255;
  out[o + 3] = c1 >> 8;
  out[o + 4] = idx & 255;
  out[o + 5] = (idx >>> 8) & 255;
  out[o + 6] = (idx >>> 16) & 255;
  out[o + 7] = (idx >>> 24) & 255;
}

export function encodeBC1(c: Canvas): Uint8Array {
  return runSync(encodeBC1Steps(c, new Budget(1e15)));
}

/** BC1 po řádcích bloků, `yield` po dávce práce rozpočtu */
export function* encodeBC1Steps(c: Canvas, b: Budget): Generator<void, Uint8Array> {
  const bw = Math.ceil(c.w / 4);
  const bh = Math.ceil(c.h / 4);
  const out = new Uint8Array(bw * bh * 8);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) encodeBlock(c.px, c.w, c.h, x * 4, y * 4, out, (y * bw + x) * 8);
    if (b.tick(bw * 24)) yield;
  }
  return out;
}

/** BC1 zpět na RGB (testy, náhled renderu) */
export function decodeBC1(data: Uint8Array, w: number, h: number): Canvas {
  const c: Canvas = { w, h, px: new Float32Array(w * h * 3) };
  const bw = Math.ceil(w / 4);
  for (let by = 0; by < Math.ceil(h / 4); by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * 8;
      const c0 = data[o] | (data[o + 1] << 8);
      const c1 = data[o + 2] | (data[o + 3] << 8);
      const e0 = from565(c0);
      const e1 = from565(c1);
      const pal = c0 > c1 ? [e0, e1, e0.map((v, i) => (2 * v + e1[i]) / 3), e0.map((v, i) => (v + 2 * e1[i]) / 3)] : [e0, e1, e0.map((v, i) => (v + e1[i]) / 2), [0, 0, 0]];
      const idx = (data[o + 4] | (data[o + 5] << 8) | (data[o + 6] << 16) | (data[o + 7] << 24)) >>> 0;
      for (let k = 0; k < 16; k++) {
        const x = bx * 4 + (k & 3);
        const y = by * 4 + (k >> 2);
        if (x >= w || y >= h) continue;
        const q = pal[(idx >>> (k * 2)) & 3];
        const t = (y * w + x) * 3;
        c.px[t] = q[0];
        c.px[t + 1] = q[1];
        c.px[t + 2] = q[2];
      }
    }
  }
  return c;
}

/** polovina rozměru (průměr 2×2) */
export function halve(c: Canvas): Canvas {
  return runSync(halveSteps(c, new Budget(1e15)));
}

function* halveSteps(c: Canvas, b: Budget): Generator<void, Canvas> {
  const w = Math.max(1, c.w >> 1);
  const h = Math.max(1, c.h >> 1);
  const out: Canvas = { w, h, px: f32(w * h * 3) };
  for (let y = 0; y < h; y++) {
    if (b.tick(w * 4)) yield;
    for (let x = 0; x < w; x++) {
      for (let ch = 0; ch < 3; ch++) {
        const a = c.px[((y * 2) * c.w + x * 2) * 3 + ch];
        const b = c.px[((y * 2) * c.w + Math.min(c.w - 1, x * 2 + 1)) * 3 + ch];
        const d = c.px[(Math.min(c.h - 1, y * 2 + 1) * c.w + x * 2) * 3 + ch];
        const e = c.px[(Math.min(c.h - 1, y * 2 + 1) * c.w + Math.min(c.w - 1, x * 2 + 1)) * 3 + ch];
        out.px[(y * w + x) * 3 + ch] = (a + b + d + e) / 4;
      }
    }
  }
  return out;
}

/** mipmapy až do nejmenšího rozměru 4 (jako hra) */
export function mipChain(c: Canvas): Canvas[] {
  return runSync(mipChainSteps(c, new Budget(1e15)));
}

function* mipChainSteps(c: Canvas, b: Budget): Generator<void, Canvas[]> {
  const out = [c];
  while (Math.min(out[out.length - 1].w, out[out.length - 1].h) > 4) out.push(yield* halveSteps(out[out.length - 1], b));
  return out;
}

function header(w: number, h: number, mips: number, persistent: number, avg: number): Uint8Array {
  const b = new Uint8Array(148);
  const v = new DataView(b.buffer);
  b.set([0x44, 0x44, 0x53, 0x20], 0); // "DDS "
  v.setUint32(4, 124, true);
  v.setUint32(8, 0x00021007, true); // CAPS | HEIGHT | WIDTH | PIXELFORMAT | MIPMAPCOUNT
  v.setUint32(12, h, true);
  v.setUint32(16, w, true);
  v.setUint32(20, 0, true);
  v.setUint32(24, 0, true);
  v.setUint32(28, mips, true);
  v.setUint32(32, 0, true); // dwAlphaBitDepth
  v.setUint32(36, 0x00200800, true); // CryEngine reserved1 (jako textury hry)
  v.setFloat32(40, avg, true); // průměrný jas
  for (let i = 0; i < 4; i++) v.setFloat32(44 + i * 4, 0, true); // nejmenší barva
  for (let i = 0; i < 4; i++) v.setFloat32(60 + i * 4, 1, true); // největší barva
  v.setUint32(76, 32, true); // pixel format
  v.setUint32(80, 4, true); // FOURCC
  b.set([0x44, 0x58, 0x31, 0x30], 84); // "DX10"
  v.setUint32(108, 0x00401008, true); // caps: COMPLEX | TEXTURE | MIPMAP
  v.setUint32(112, 0, true);
  b[116] = persistent; // bNumPersistentMips
  b.set([0x46, 0x59, 0x52, 0x43], 124); // "FYRC"
  v.setUint32(128, BC1_SRGB, true); // DX10: dxgiFormat
  v.setUint32(132, 3, true); // TEXTURE2D
  v.setUint32(136, 0, true);
  v.setUint32(140, 1, true); // arraySize
  v.setUint32(144, 0, true);
  return b;
}

/**
 * Celá textura: mipmapy z plátna, BC1, rozdělení do souborů. persistent = kolik nejmenších mipmap zůstane v .dds
 * (hra má 4 u textur širších než vysokých, viz scroll_diff.dds a beams_connection_decal_diff.dds).
 */
export function writeDds(c: Canvas, persistent = 4): DdsFiles {
  return runSync(writeDdsSteps(c, persistent, new Budget(1e15)));
}

/** writeDds po kouscích (mipmapy, BC1, průměrný jas), `yield` po dávce práce rozpočtu; mipmapy 1+ jdou do zásobníku */
export function* writeDdsSteps(c: Canvas, persistent: number, b: Budget): Generator<void, DdsFiles> {
  const chain = yield* mipChainSteps(c, b);
  const enc: Uint8Array[] = [];
  for (const m of chain) enc.push(yield* encodeBC1Steps(m, b));
  for (let i = 1; i < chain.length; i++) release(chain[i].px);
  const n = chain.length;
  const keep = Math.min(persistent, n);
  let avg = 0;
  const step = c.w * 3;
  for (let i = 0; i < c.px.length; i += 3) {
    avg += (c.px[i] * 0.299 + c.px[i + 1] * 0.587 + c.px[i + 2] * 0.114) / 255;
    if (i % step === 0 && b.tick(c.w)) yield;
  }
  avg /= c.px.length / 3;
  const files = new Map<string, Uint8Array>();
  const tail = enc.slice(n - keep);
  const head = header(c.w, c.h, n, keep, avg);
  const base = new Uint8Array(head.length + tail.reduce((s, x) => s + x.length, 0));
  base.set(head, 0);
  let o = head.length;
  for (const t of tail) {
    base.set(t, o);
    o += t.length;
  }
  files.set("", base);
  // .dds.1 = nejmenší z oddělených, .dds.N = plný rozměr
  for (let i = 0; i < n - keep; i++) files.set(String(n - keep - i), enc[i]);
  let bytes = 0;
  for (const f of files.values()) bytes += f.length;
  return { files, w: c.w, h: c.h, mips: n, bytes };
}

/** přečte rozdělenou texturu zpět: mipmapa `level` (0 = plná) jako RGB */
export function readDds(files: Map<string, Uint8Array>, level = 0): Canvas {
  const base = files.get("")!;
  const v = new DataView(base.buffer, base.byteOffset, base.byteLength);
  const h = v.getUint32(12, true);
  const w = v.getUint32(16, true);
  const n = v.getUint32(28, true);
  const keep = base[116];
  const lw = Math.max(1, w >> level);
  const lh = Math.max(1, h >> level);
  if (level < n - keep) return decodeBC1(files.get(String(n - keep - level))!, lw, lh);
  let o = 148;
  for (let i = n - keep; i < level; i++) o += Math.ceil(Math.max(1, w >> i) / 4) * Math.ceil(Math.max(1, h >> i) / 4) * 8;
  return decodeBC1(base.subarray(o), lw, lh);
}
