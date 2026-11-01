// Rastr kresby na serveru: papír (pergamen se skvrnami, papír s žebrováním) a tahy se všemi dobovými efekty - převod
// serverového vykreslení KCD:MP (../../server/kresby_png.lua, drawStroke / fillPaper) do TypeScriptu. Výsledek jde
// do textury listu ve světě (server/texture.ts): osvětlený povrch se stíny, ne samosvítící čáry.
//
// Vykresluje se po kouscích (generátor, `yield` po zhruba 2 ms práce), aby jedna velká kresba nezdržela tick serveru.

import { TOOL, type Drawing, type Stroke } from "../shared/codec";
import { CHARCOAL_RGB, PRESSURE, strokeInk } from "../shared/ink";
import { LOOK, paperOf } from "../shared/look";

export interface Canvas {
  w: number;
  h: number;
  /** RGB po trojicích 0..255 */
  px: Float32Array;
}

const floor = Math.floor;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export function hash(x: number, y: number, s: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) & 0xffffff) / 16777216;
}

function valueNoise(x: number, y: number, s: number): number {
  const ix = floor(x);
  const iy = floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, s);
  const b = hash(ix + 1, iy, s);
  const c = hash(ix, iy + 1, s);
  const d = hash(ix + 1, iy + 1, s);
  return a + (b - a) * fx + (c + (d - c) * fx - (a + (b - a) * fx)) * fy;
}

/** barva papíru v bodě listu (lx, ly = px uvnitř listu, w, h = rozměr listu v px, k = px na logický px) */
export function paperAt(kod: number, lx: number, ly: number, w: number, h: number, k: number): [number, number, number] {
  const P = paperOf(kod);
  const base = P.rgb;
  let shade: number;
  if (P.styl === "papir") {
    const chain = floor(lx / k) % 110 < 2 ? -7 : 0; // žebrování po ~110 logických px
    shade = (valueNoise(lx / (6 * k), ly / (6 * k), 11) - 0.5) * 4 + chain;
  } else if (P.styl === "hladky") {
    shade = (valueNoise(lx / (5 * k), ly / (5 * k), 13) - 0.5) * 3;
  } else {
    shade = (valueNoise(lx / (40 * k), ly / (40 * k), 7) - 0.5) * 16 + (valueNoise(lx / (9 * k), ly / (9 * k), 8) - 0.5) * 5;
  }
  const ex = Math.min(lx, w - 1 - lx) / Math.max(1, w * 0.12);
  const ey = Math.min(ly, h - 1 - ly) / Math.max(1, h * 0.12);
  const edge = Math.min(1, ex, ey);
  shade -= (1 - edge) * (1 - edge) * 22;
  shade = floor(shade / 3 + 0.5) * 3;
  return [base[0] + shade, base[1] + shade, base[2] + shade * 1.25];
}

/** pracovní "hodiny": generátor se po vyčerpání dávky práce vzdá řízení */
class Budget {
  ops = 0;
  constructor(public limit = 60000) {}
  tick(w = 1) {
    this.ops += w;
    if (this.ops >= this.limit) {
      this.ops = 0;
      return true;
    }
    return false;
  }
}

function* fillPaper(cv: Canvas, kod: number, k: number, b: Budget) {
  const { w, h, px } = cv;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = paperAt(kod, x, y, w, h, k);
      const i = (y * w + x) * 3;
      px[i] = clamp(c[0], 0, 255);
      px[i + 1] = clamp(c[1], 0, 255);
      px[i + 2] = clamp(c[2], 0, 255);
    }
    if (b.tick(w)) yield;
  }
}

/** jeden tah do plátna (k = px plátna na logický px), seed = pořadí tahu od 1 */
function* drawStroke(cv: Canvas, s: Stroke, d: Drawing, seed: number, k: number, mask: Float32Array, touched: Int32Array, b: Budget) {
  const p = s.p;
  if (p.length < 3) return;
  const fx = LOOK.fx;
  const { w: W, h: H, px } = cv;
  const tool = s.tool;
  const ink = strokeInk(s, d.inks);
  const rgb = tool === TOOL.charcoal ? CHARCOAL_RGB : ink.rgb;
  const mode = ink.mode; // 0 násobit, 1 navrch, 2 seškrábat
  const hardness = tool === TOOL.pen ? fx.pen.hardness : tool === TOOL.brush ? fx.brush.hardness : tool === TOOL.charcoal ? fx.charcoal.hardness : 0.6;
  const baseR = Math.max(0.45, ((s.size / 4) * k) / 2);
  const press = PRESSURE[tool] ?? PRESSURE[0];
  let nt = 0;

  const stamp = (cx: number, cy: number, r: number, mul: number, pr: number) => {
    const rr = r * r;
    const inner = r * hardness;
    const span = Math.max(0.001, r - inner);
    const ya = Math.max(0, floor(cy - r));
    const yb = Math.min(H - 1, floor(cy + r));
    const xa = Math.max(0, floor(cx - r));
    const xb = Math.min(W - 1, floor(cx + r));
    for (let yy = ya; yy <= yb; yy++) {
      const dy = yy + 0.5 - cy;
      const row = yy * W;
      for (let xx = xa; xx <= xb; xx++) {
        const dx = xx + 0.5 - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 > rr + 0.25) continue;
        const dd = Math.sqrt(d2);
        let cov = dd <= inner ? 1 : Math.max(0, 1 - (dd - inner) / span);
        if (r < 1) cov = Math.max(cov, 0.6);
        if (tool === TOOL.charcoal) {
          const grain = valueNoise(xx / 1.4, yy / 1.4, 3) * 0.7 + valueNoise(xx / 3.5, yy / 3.5, 5) * 0.3;
          const g = clamp((grain - (0.78 - 0.55 * pr)) * 3.2, 0, 1);
          cov *= 1 - fx.charcoal.grain + fx.charcoal.grain * g;
        }
        const v = cov * mul;
        const idx = row + xx;
        if (v > mask[idx]) {
          if (mask[idx] === 0) touched[nt++] = idx;
          mask[idx] = v;
        }
      }
    }
    return (yb - ya + 1) * (xb - xa + 1);
  };

  let total = 0;
  for (let i = 3; i + 2 < p.length; i += 3) total += Math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2]);
  const load = (L: number) =>
    ink.even ? 1 : tool === TOOL.pen ? Math.max(0.42, 1 - L / Math.max(1, fx.pen.fade)) : tool === TOOL.brush ? Math.max(0.35, 1 - L / Math.max(1, fx.brush.fade)) : 1;
  const taper = (L: number) => (tool !== TOOL.pen || ink.even || total < 12 ? 1 : 1 - fx.pen.taper + fx.pen.taper * Math.min(1, L / 10, (total - L) / 14));

  let L = 0;
  let qx = p[0] * k;
  let qy = p[1] * k;
  let qpr = p[2] / 15;
  if (b.tick(stamp(qx, qy, baseR * press(qpr) * taper(0), load(0), qpr))) yield;
  for (let i = 3; i + 2 < p.length; i += 3) {
    const x = p[i] * k;
    const y = p[i + 1] * k;
    const pr = p[i + 2] / 15;
    const seg = Math.hypot(x - qx, y - qy);
    const segL = seg / k;
    const n = Math.max(1, Math.ceil(seg / Math.max(0.35, baseR * 0.3)));
    for (let t = 1; t <= n; t++) {
      const f = t / n;
      const prr = qpr + (pr - qpr) * f;
      if (b.tick(stamp(qx + (x - qx) * f, qy + (y - qy) * f, baseR * press(prr) * taper(L + segL * f), load(L + segL * f), prr))) yield;
    }
    L += segL;
    qx = x;
    qy = y;
    qpr = pr;
  }

  // kaňka: brk občas ukápne na začátku tahu
  if (tool === TOOL.pen && !ink.even && hash(seed, p.length, 17) < fx.pen.blot) {
    const bx = p[0] * k;
    const by = p[1] * k;
    const br = baseR * (1.8 + hash(seed, 1, 18) * 1.4);
    for (let yy = Math.max(0, floor(by - br * 1.4)); yy <= Math.min(H - 1, floor(by + br * 1.4)); yy++) {
      for (let xx = Math.max(0, floor(bx - br * 1.4)); xx <= Math.min(W - 1, floor(bx + br * 1.4)); xx++) {
        const dd = Math.hypot(xx + 0.5 - bx, yy + 0.5 - by);
        if (dd <= br * (0.75 + 0.5 * valueNoise(xx / 1.7, yy / 1.7, seed))) {
          const idx = yy * W + xx;
          if (mask[idx] === 0) touched[nt++] = idx;
          mask[idx] = 1;
        }
      }
    }
  }

  const op = (s.op / 255) * ink.strength;
  const ir = rgb[0] / 255;
  const ig = rgb[1] / 255;
  const ib = rgb[2] / 255;
  const wet = fx.brush.wet;
  const glint = fx.gold.glint;
  for (let j = 0; j < nt; j++) {
    const idx = touched[j];
    const cov = mask[idx];
    mask[idx] = 0;
    let a = cov * op;
    if (tool === TOOL.brush) a = Math.min(1, a * (1 + wet * Math.sin(Math.PI * cov))); // mokrý okraj
    if (a <= 0.004) continue;
    const o = idx * 3;
    let r = px[o];
    let g = px[o + 1];
    let bb = px[o + 2];
    if (tool === TOOL.scrape) {
      const xx = idx % W;
      const yy = (idx - xx) / W;
      const c = paperAt(d.paper, xx, yy, W, H, k);
      const st = fx.scrape.strength;
      r += (c[0] * 0.96 - r) * a * st;
      g += (c[1] * 0.96 - g) * a * st;
      bb += (c[2] * 0.95 - bb) * a * st;
    } else if (mode === 0 && tool !== TOOL.charcoal) {
      r *= 1 - a + a * ir;
      g *= 1 - a + a * ig;
      bb *= 1 - a + a * ib;
    } else {
      let cr = rgb[0];
      let cg = rgb[1];
      let cb = rgb[2];
      if (ink.gold) {
        const xx = idx % W;
        const yy = (idx - xx) / W;
        const gl = 1 - glint * 0.5 + glint * hash(xx >> 1, yy >> 1, 21);
        cr = Math.min(255, cr * gl);
        cg = Math.min(255, cg * gl);
        cb = Math.min(255, cb * gl);
      }
      r += (cr - r) * a;
      g += (cg - g) * a;
      bb += (cb - bb) * a;
    }
    px[o] = clamp(r, 0, 255);
    px[o + 1] = clamp(g, 0, 255);
    px[o + 2] = clamp(bb, 0, 255);
    if ((j & 4095) === 4095 && b.tick(4096 / 8)) yield;
  }
}

/** celý list: plátno 768·k × 512·k (k = px na logický px listu) */
export function* renderSheet(d: Drawing, k: number, limit = 60000): Generator<void, Canvas> {
  const w = Math.round(768 * k);
  const h = Math.round(512 * k);
  const cv: Canvas = { w, h, px: new Float32Array(w * h * 3) };
  const b = new Budget(limit);
  yield* fillPaper(cv, d.paper, k, b);
  const mask = new Float32Array(w * h);
  const touched = new Int32Array(w * h);
  for (let i = 0; i < d.strokes.length; i++) yield* drawStroke(cv, d.strokes[i], d, i + 1, k, mask, touched, b);
  return cv;
}

/** zmenšení plochou (box filter s podílem pixelů), libovolný poměr: z plátna na rozměr textury */
export function resample(src: Canvas, w: number, h: number): Canvas {
  const out: Canvas = { w, h, px: new Float32Array(w * h * 3) };
  const sx = src.w / w;
  const sy = src.h / h;
  // nejdřív vodorovně, pak svisle
  const tmp = new Float32Array(w * src.h * 3);
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < w; x++) {
      const a = x * sx;
      const bnd = a + sx;
      let r = 0;
      let g = 0;
      let bl = 0;
      for (let i = floor(a); i < Math.ceil(bnd); i++) {
        const wgt = Math.min(bnd, i + 1) - Math.max(a, i);
        const o = (y * src.w + Math.min(src.w - 1, i)) * 3;
        r += src.px[o] * wgt;
        g += src.px[o + 1] * wgt;
        bl += src.px[o + 2] * wgt;
      }
      const t = (y * w + x) * 3;
      tmp[t] = r / sx;
      tmp[t + 1] = g / sx;
      tmp[t + 2] = bl / sx;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const a = y * sy;
      const bnd = a + sy;
      let r = 0;
      let g = 0;
      let bl = 0;
      for (let i = floor(a); i < Math.ceil(bnd); i++) {
        const wgt = Math.min(bnd, i + 1) - Math.max(a, i);
        const o = (Math.min(src.h - 1, i) * w + x) * 3;
        r += tmp[o] * wgt;
        g += tmp[o + 1] * wgt;
        bl += tmp[o + 2] * wgt;
      }
      const t = (y * w + x) * 3;
      out.px[t] = r / sy;
      out.px[t + 1] = g / sy;
      out.px[t + 2] = bl / sy;
    }
  }
  return out;
}

/** doběhne generátor naráz (testy, nástroje buildu) */
export function runSync<T>(g: Generator<void, T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

