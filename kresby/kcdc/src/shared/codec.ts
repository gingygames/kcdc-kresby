// Kodek kresby - stejný model jako modul pro KCD:MP (../../server/kresby_png.lua).
//
// Kresba = { paper: 0|1, inks: [{ rgb, flags, strength }], strokes: [{ tool, a, b, mix, size, op, p: [x, y, pr, ...] }] }
//   tool   0 brk, 1 štětec, 2 uhel, 3 škrabka
//   a, b   index inkoustu od 1 (0 = žádný); mix = podíl b 0..255
//   size   průměr ve čtvrtpixelech listu 768 × 512 (2..160 = 0,5..40 px)
//   op     krytí 0..255; pr = přítlak 0..15; x 0..767, y 0..511 (logické px listu)
//
// Formáty:
//   "k2." base64, varinty a zigzag rozdíly - výměnný formát, čte ho i Lua (KCD:MP) a umí "k1." (starý)
//   "k3." base64, adaptivní binární aritmetický kodér s kontexty po polích a rozdíly 2. řádu u souřadnic.
//         Jen KCDC; kresba v něm má zhruba 45-60 % velikosti k2 (test/codec.test.ts), tím se vejde do dat předmětu (16 KiB).

export interface Ink {
  rgb: [number, number, number];
  flags: number; // 1 krycí, 2 zlatý (zlatý je vždy i krycí: 3), 4 rovnoměrný tah (sazba: bez kaněk, ztenčení a slábnutí)
  strength: number; // sytost 0..255
}

export interface Stroke {
  tool: number;
  a: number;
  b: number;
  mix: number;
  size: number;
  op: number;
  p: number[];
}

export interface Drawing {
  paper: number;
  inks: Ink[];
  strokes: Stroke[];
}

export const SRC_W = 768;
export const SRC_H = 512;
export const TOOL = { pen: 0, brush: 1, charcoal: 2, scrape: 3 } as const;
export const MAX_INKS = 16;
const MAX_STROKES = 3000;
const MAX_POINTS = 4096;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const zig = (v: number) => (v >= 0 ? v * 2 : -v * 2 - 1);
const unzig = (v: number) => (v % 2 === 1 ? -(v + 1) / 2 : v / 2);

// ---------------------------------------------------------------------------
// base64 (standardní abeceda s "=", jako Lua)

const B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64 = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64[B64C.charCodeAt(i)] = i;

export function b64encode(b: ArrayLike<number>, n = b.length): string {
  let out = "";
  for (let i = 0; i < n; i += 3) {
    const v = (b[i] << 16) | ((i + 1 < n ? b[i + 1] : 0) << 8) | (i + 2 < n ? b[i + 2] : 0);
    const rest = n - i;
    out += B64C[(v >> 18) & 63] + B64C[(v >> 12) & 63] + (rest > 1 ? B64C[(v >> 6) & 63] : "=") + (rest > 2 ? B64C[v & 63] : "=");
  }
  return out;
}

export function b64decode(s: string, from = 0): Uint8Array | null {
  const out = new Uint8Array(Math.floor(((s.length - from) * 3) / 4) + 3);
  let n = 0;
  let acc = 0;
  let bits = 0;
  for (let i = from; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61) break;
    const v = c < 128 ? B64[c] : -1;
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

// ---------------------------------------------------------------------------
// k1 / k2 (bajtové varinty)

function reader(b: Uint8Array, pos: number) {
  return {
    byte(): number {
      if (pos >= b.length) throw new Error("eof");
      return b[pos++];
    },
    varint(): number {
      let v = 0;
      let mul = 1;
      for (;;) {
        if (pos >= b.length || mul > 2 ** 28) throw new Error("varint");
        const x = b[pos++];
        v += (x & 0x7f) * mul;
        mul *= 128;
        if (x < 0x80) return v;
      }
    },
    more: () => pos < b.length,
  };
}

const OLD_K1: [number, number, number][] = [[0x1d, 0x1a, 0x17], [0x5b, 0x3a, 0x1e], [0x9b, 0x2d, 0x1f], [0xb8, 0x86, 0x2b],
  [0x4f, 0x6b, 0x3a], [0x2f, 0x4f, 0x7f], [0xf1, 0xea, 0xd8]];
const OLD_WIDTHS = [2, 4, 8, 16];

function decodeK1(b: Uint8Array): Drawing {
  const r = reader(b, 1);
  const d: Drawing = { paper: 0, inks: OLD_K1.map((rgb, i) => ({ rgb, flags: i === 6 ? 1 : 0, strength: 255 })), strokes: [] };
  while (r.more() && d.strokes.length < MAX_STROKES) {
    const h = r.byte();
    const count = r.varint();
    if (count < 1 || count > MAX_POINTS) throw new Error("points");
    const c = h & 7;
    const w = (h >> 3) & 3;
    let x = r.varint();
    let y = r.varint();
    const p = [x, y, 15];
    for (let k = 1; k < count; k++) {
      x += unzig(r.varint());
      y += unzig(r.varint());
      p.push(x, y, 15);
    }
    d.strokes.push({ tool: c === 7 ? 3 : 0, a: c === 7 ? 0 : c + 1, b: 0, mix: 0, size: OLD_WIDTHS[w] * 4, op: 255, p });
  }
  return d;
}

function decodeK2(b: Uint8Array, maxInk?: number): Drawing {
  const r = reader(b, 1);
  const d: Drawing = { paper: clamp(r.byte(), 0, 1), inks: [], strokes: [] };
  const count = r.byte();
  if (count > MAX_INKS) throw new Error("inks");
  for (let i = 0; i < count; i++) d.inks.push({ rgb: [r.byte(), r.byte(), r.byte()], flags: r.byte(), strength: r.byte() });
  while (r.more() && d.strokes.length < MAX_STROKES) {
    const s: Stroke = { tool: r.byte(), a: r.byte(), b: r.byte(), mix: r.byte(), size: r.byte(), op: r.byte(), p: [] };
    const lim = maxInk ?? count;
    if (s.tool > 3 || s.a > lim || s.b > lim || s.size < 1) throw new Error("stroke");
    const pts = r.varint();
    if (pts < 1 || pts > MAX_POINTS) throw new Error("points");
    let x = r.varint();
    let y = r.varint();
    let pr = r.varint();
    s.p.push(x, y, clamp(pr, 0, 15));
    for (let k = 1; k < pts; k++) {
      x += unzig(r.varint());
      y += unzig(r.varint());
      pr += unzig(r.varint());
      s.p.push(x, y, clamp(pr, 0, 15));
    }
    d.strokes.push(s);
  }
  return d;
}

export function encodeK2(d: Drawing): string {
  const b: number[] = [2];
  const varint = (v: number) => {
    while (v >= 0x80) {
      b.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    b.push(v);
  };
  b.push(d.paper || 0, d.inks.length);
  for (const ink of d.inks) b.push(ink.rgb[0], ink.rgb[1], ink.rgb[2], ink.flags || 0, ink.strength ?? 255);
  for (const s of d.strokes) {
    const p = s.p;
    const count = Math.floor(p.length / 3);
    b.push(s.tool, s.a, s.b, s.mix, s.size, s.op);
    varint(count);
    varint(p[0]);
    varint(p[1]);
    varint(p[2]);
    for (let i = 3; i < count * 3; i += 3) {
      varint(zig(p[i] - p[i - 3]));
      varint(zig(p[i + 1] - p[i - 2]));
      varint(zig(p[i + 2] - p[i - 1]));
    }
  }
  return "k2." + b64encode(b);
}

// ---------------------------------------------------------------------------
// k3: binární aritmetický kodér (32bitový, pravděpodobnosti 12 bitů, adaptace 1/32)

const enum C {
  HDR, TOOL, INK, MIX, SIZE, OP, COUNT, X0, Y0, PR0, DX, DY, DPR, N,
}
const UNARY = 26; // kontextů pro délku čísla
const MANT = 2; // adaptivních bitů mantisy
const CTX_SIZE = UNARY + UNARY * 4 * MANT;

function models() {
  const m: Uint16Array[] = [];
  for (let i = 0; i < C.N; i++) m.push(new Uint16Array(CTX_SIZE).fill(2048));
  return m;
}

class Encoder {
  private x1 = 0;
  private x2 = 0xffffffff;
  out: number[] = [];
  bit(bit: number, m: Uint16Array | null, i: number) {
    const p = m ? m[i] : 2048;
    const xmid = this.x1 + ((this.x2 - this.x1) >>> 12) * p;
    if (bit) this.x2 = xmid;
    else this.x1 = xmid + 1;
    if (m) {
      if (bit) m[i] += (4096 - p) >> 5;
      else m[i] -= p >> 5;
    }
    while (((this.x1 ^ this.x2) & 0xff000000) === 0) {
      this.out.push(this.x2 >>> 24);
      this.x1 = (this.x1 << 8) >>> 0;
      this.x2 = ((this.x2 << 8) | 255) >>> 0;
    }
  }
  flush() {
    const x = this.x1;
    this.out.push(x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
  }
}

class Decoder {
  private x1 = 0;
  private x2 = 0xffffffff;
  private x = 0;
  private pos: number;
  constructor(private b: Uint8Array, from: number) {
    this.pos = from;
    for (let i = 0; i < 4; i++) this.x = ((this.x << 8) | this.next()) >>> 0;
  }
  private next() {
    return this.pos < this.b.length ? this.b[this.pos++] : 0;
  }
  overrun() {
    return this.pos > this.b.length + 4;
  }
  bit(m: Uint16Array | null, i: number): number {
    const p = m ? m[i] : 2048;
    const xmid = this.x1 + ((this.x2 - this.x1) >>> 12) * p;
    const bit = this.x <= xmid ? 1 : 0;
    if (bit) this.x2 = xmid;
    else this.x1 = xmid + 1;
    if (m) {
      if (bit) m[i] += (4096 - p) >> 5;
      else m[i] -= p >> 5;
    }
    while (((this.x1 ^ this.x2) & 0xff000000) === 0) {
      this.x1 = (this.x1 << 8) >>> 0;
      this.x2 = ((this.x2 << 8) | 255) >>> 0;
      this.x = ((this.x << 8) | this.next()) >>> 0;
    }
    return bit;
  }
}

// nezáporné celé číslo: délka (v+1) unárně adaptivně, 2 horní bity mantisy adaptivně, zbytek přímo
function putNum(e: Encoder, m: Uint16Array, v: number) {
  const w = v + 1;
  let n = 0;
  while (w >= 2 ** (n + 1)) n++;
  for (let k = 0; k < n; k++) e.bit(1, m, Math.min(k, UNARY - 1));
  e.bit(0, m, Math.min(n, UNARY - 1));
  for (let k = n - 1; k >= 0; k--) {
    const bit = Math.floor(w / 2 ** k) & 1;
    const j = n - 1 - k;
    if (j < MANT) e.bit(bit, m, UNARY + (Math.min(n, UNARY - 1) * 4 + (j === 0 ? 0 : 1 + (Math.floor(w / 2 ** (k + 1)) & 1))) * MANT + j);
    else e.bit(bit, null, 0);
  }
}

function getNum(d: Decoder, m: Uint16Array): number {
  let n = 0;
  while (d.bit(m, Math.min(n, UNARY - 1))) {
    n++;
    if (n > 40) throw new Error("num");
  }
  let w = 1;
  for (let j = 0; j < n; j++) {
    const bit = j < MANT ? d.bit(m, UNARY + (Math.min(n, UNARY - 1) * 4 + (j === 0 ? 0 : 1 + (w & 1))) * MANT + j) : d.bit(null, 0);
    w = w * 2 + bit;
  }
  return w - 1;
}

export function encodeK3(dr: Drawing): string {
  const e = new Encoder();
  const m = models();
  putNum(e, m[C.HDR], dr.paper || 0);
  putNum(e, m[C.HDR], dr.inks.length);
  for (const ink of dr.inks) {
    for (const v of [ink.rgb[0], ink.rgb[1], ink.rgb[2], ink.flags || 0, ink.strength ?? 255]) putNum(e, m[C.HDR], v);
  }
  putNum(e, m[C.HDR], dr.strokes.length);
  for (const s of dr.strokes) {
    const p = s.p;
    const count = Math.floor(p.length / 3);
    putNum(e, m[C.TOOL], s.tool);
    putNum(e, m[C.INK], s.a);
    putNum(e, m[C.INK], s.b);
    if (s.b) putNum(e, m[C.MIX], s.mix);
    putNum(e, m[C.SIZE], s.size);
    putNum(e, m[C.OP], 255 - s.op);
    putNum(e, m[C.COUNT], count - 1);
    putNum(e, m[C.X0], p[0]);
    putNum(e, m[C.Y0], p[1]);
    putNum(e, m[C.PR0], p[2]);
    let pdx = 0;
    let pdy = 0;
    for (let i = 3; i < count * 3; i += 3) {
      const dx = p[i] - p[i - 3];
      const dy = p[i + 1] - p[i - 2];
      putNum(e, m[C.DX], zig(dx - pdx));
      putNum(e, m[C.DY], zig(dy - pdy));
      putNum(e, m[C.DPR], zig(p[i + 2] - p[i - 1]));
      pdx = dx;
      pdy = dy;
    }
  }
  e.flush();
  return "k3." + b64encode([3, ...e.out]);
}

function decodeK3(b: Uint8Array, maxInk?: number): Drawing {
  const d = new Decoder(b, 1);
  const m = models();
  const paper = clamp(getNum(d, m[C.HDR]), 0, 31); // k3: kód papíru 0..31 (k2 jen 0..1 jako KCD:MP)
  const count = getNum(d, m[C.HDR]);
  if (count > MAX_INKS) throw new Error("inks");
  const dr: Drawing = { paper, inks: [], strokes: [] };
  for (let i = 0; i < count; i++) {
    const v = [0, 0, 0, 0, 0].map(() => getNum(d, m[C.HDR]));
    if (v.some((x) => x > 255)) throw new Error("ink");
    dr.inks.push({ rgb: [v[0], v[1], v[2]], flags: v[3], strength: v[4] });
  }
  const strokes = getNum(d, m[C.HDR]);
  if (strokes > MAX_STROKES) throw new Error("strokes");
  for (let k = 0; k < strokes; k++) {
    const tool = getNum(d, m[C.TOOL]);
    const a = getNum(d, m[C.INK]);
    const bb = getNum(d, m[C.INK]);
    const mix = bb ? getNum(d, m[C.MIX]) : 0;
    const size = getNum(d, m[C.SIZE]);
    const op = 255 - getNum(d, m[C.OP]);
    const pts = getNum(d, m[C.COUNT]) + 1;
    const lim = maxInk ?? count;
    if (tool > 3 || a > lim || bb > lim || size < 1 || size > 255 || op < 0 || mix > 255 || pts > MAX_POINTS) throw new Error("stroke");
    let x = getNum(d, m[C.X0]);
    let y = getNum(d, m[C.Y0]);
    let pr = getNum(d, m[C.PR0]);
    const p = [x, y, clamp(pr, 0, 15)];
    let pdx = 0;
    let pdy = 0;
    for (let i = 1; i < pts; i++) {
      const dx = pdx + unzig(getNum(d, m[C.DX]));
      const dy = pdy + unzig(getNum(d, m[C.DY]));
      x += dx;
      y += dy;
      pr += unzig(getNum(d, m[C.DPR]));
      p.push(x, y, clamp(pr, 0, 15));
      pdx = dx;
      pdy = dy;
    }
    if (d.overrun()) throw new Error("eof");
    dr.strokes.push({ tool, a, b: bb, mix, size, op, p });
  }
  return dr;
}

// ---------------------------------------------------------------------------

/**
 * data od hráčů i z úložiště: při jakékoli chybě null.
 * maxInk: zpráva jen s tahy (dávka, živé kreslení) - inkousty jsou jinde, tahy smí odkazovat až na maxInk.
 */
export function decode(data: unknown, maxInk?: number): Drawing | null {
  if (typeof data !== "string" || data.length < 4 || data.length > 400000) return null;
  const prefix = data.slice(0, 3);
  if (prefix !== "k1." && prefix !== "k2." && prefix !== "k3.") return null;
  const b = b64decode(data, 3);
  if (!b || b.length < 1) return null;
  try {
    if (prefix === "k1." && b[0] === 1) return decodeK1(b);
    if (prefix === "k2." && b[0] === 2) return decodeK2(b, maxInk);
    if (prefix === "k3." && b[0] === 3) return decodeK3(b, maxInk);
  } catch {
    return null;
  }
  return null;
}

/** druh papíru bez dekódování celé kresby */
export function paperOf(data: string): number {
  const d = data.startsWith("k2.") ? b64decode(data.slice(0, 8), 3) : null;
  if (d) return d[1] === 1 ? 1 : 0;
  return decode(data)?.paper ?? 0;
}

/** 64bitový otisk (dvě FNV-1a s různým základem), 16 hex znaků - klíč mezipaměti kreseb */
export function hashOf(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    b ^= b >>> 15;
  }
  return a.toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

export function countPoints(d: Drawing): number {
  let n = 0;
  for (const s of d.strokes) n += Math.floor(s.p.length / 3);
  return n;
}
