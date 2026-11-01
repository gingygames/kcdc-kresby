// Vektorové vykreslení kresby pro nativní cesty KCDC: Scaleform (kreslicí API movie clipu) a Gizmos (3D čáry ve světě).
//
// KCD:MP vykresluje kresbu na serveru do rastru (kresby_png.lua). KCDC dynamické textury nemá, takže kresba se
// kreslí čarami a dobové efekty jsou převedené do čar:
//   brk      šířka podle přítlaku, náběh a dotažení tahu, inkoust během dlouhého tahu slábne, občas kaňka
//   štětec   dvě vrstvy: širší řidší s tmavším (mokrým) okrajem a užší jádro
//   uhel     řidší čára a druhá roztřesená (zrno papíru), deterministicky podle otisku
//   škrabka  barvou papíru
//   zlato    navrch světlejší tenký lesk
// LOD: body tahu se zjednoduší (Ramer-Douglas-Peucker) s tolerancí podle velikosti listu na obrazovce.

import { SRC_H, SRC_W, TOOL, type Drawing, type Stroke } from "./codec";
import { PRESSURE, mixRGB, paperOf, rgbInt, strokeInk, type RGB } from "./ink";
import { LOOK } from "./look";

/** úsek tahu se stejnou barvou a skládáním; w a a jsou po segmentech (délka = body - 1) */
export interface Run {
  mode: 0 | 1 | 2; // 0 násobit (průhledný inkoust), 1 navrch, 2 seškrábat (barva papíru)
  color: number; // 0xRRGGBB
  pts: number[]; // x, y, x, y ... (logické px listu 768 × 512)
  w: number[]; // šířka segmentu (logické px)
  a: number[]; // krytí segmentu 0..1
}

export interface Dot {
  mode: 0 | 1;
  color: number;
  alpha: number;
  x: number;
  y: number;
  r: number;
}

export interface Ops {
  runs: Run[];
  dots: Dot[];
  segments: number;
}

export function hash(x: number, y: number, s: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) & 0xffffff) / 16777216;
}

/** Ramer-Douglas-Peucker nad trojicemi (x, y, přítlak); eps v logických px, 0 = beze změny */
export function simplify(p: number[], eps: number): number[] {
  const n = Math.floor(p.length / 3);
  if (eps <= 0 || n <= 2) return p;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  const e2 = eps * eps;
  while (stack.length) {
    const j = stack.pop()!;
    const i = stack.pop()!;
    const ax = p[i * 3];
    const ay = p[i * 3 + 1];
    const dx = p[j * 3] - ax;
    const dy = p[j * 3 + 1] - ay;
    const L = dx * dx + dy * dy;
    let best = -1;
    let bd = e2;
    for (let k = i + 1; k < j; k++) {
      const px = p[k * 3] - ax;
      const py = p[k * 3 + 1] - ay;
      let d: number;
      if (L === 0) d = px * px + py * py;
      else {
        const c = px * dy - py * dx;
        d = (c * c) / L;
      }
      // výrazná změna přítlaku se zachová taky (tvar šířky tahu)
      if (Math.abs(p[k * 3 + 2] - p[i * 3 + 2]) > 6) d = Math.max(d, e2 * 1.01);
      if (d > bd) {
        bd = d;
        best = k;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push(i, best, best, j);
    }
  }
  const out: number[] = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]);
  return out;
}

const darker = (c: RGB, f: number): RGB => [c[0] * f, c[1] * f, c[2] * f].map((v) => Math.max(0, Math.min(255, Math.round(v)))) as RGB;

function strokeLength(p: number[]): number {
  let L = 0;
  for (let i = 3; i + 2 < p.length; i += 3) L += Math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2]);
  return L;
}

/** jeden tah do čar; seed = pořadí tahu od 1 (jako v KCD:MP) */
export function strokeOps(s: Stroke, d: Drawing, seed: number, eps: number, out: Ops) {
  const p = simplify(s.p, eps);
  const n = Math.floor(p.length / 3);
  if (n < 1) return;
  const ink = strokeInk(s, d.inks);
  const paper = paperOf(d.paper).rgb;
  const fx = LOOK.fx;
  const base = Math.max(0.5, s.size / 4);
  const press = PRESSURE[s.tool] ?? PRESSURE[0];
  const op = (s.op / 255) * ink.strength;
  const total = strokeLength(p);
  const load = (L: number) =>
    ink.even ? 1 : s.tool === TOOL.pen ? Math.max(0.42, 1 - L / Math.max(1, fx.pen.fade)) : s.tool === TOOL.brush ? Math.max(0.35, 1 - L / Math.max(1, fx.brush.fade)) : 1;
  const taper = (L: number) => (s.tool !== TOOL.pen || ink.even || total < 12 ? 1 : 1 - fx.pen.taper + fx.pen.taper * Math.min(1, L / 10, (total - L) / 14));
  const color = s.tool === TOOL.scrape ? darker(paper, 0.96) : ink.rgb;

  const pts: number[] = [];
  const w: number[] = [];
  const a: number[] = [];
  let L = 0;
  for (let k = 0; k < n; k++) {
    const x = p[k * 3];
    const y = p[k * 3 + 1];
    if (k > 0) {
      const seg = Math.hypot(x - p[k * 3 - 3], y - p[k * 3 - 2]);
      const mid = L + seg / 2;
      const pr = (p[k * 3 + 2] + p[k * 3 - 1]) / 30;
      w.push(base * press(pr) * taper(mid));
      a.push(Math.min(1, op * load(mid)));
      L += seg;
    }
    pts.push(x, y);
  }
  if (n === 1) {
    // tečka
    out.dots.push({ mode: ink.mode === 0 ? 0 : 1, color: rgbInt(color), alpha: Math.min(1, op), x: p[0], y: p[1], r: (base * press(p[2] / 15)) / 2 });
    return;
  }
  const mode = ink.mode;
  if (s.tool === TOOL.brush) {
    out.runs.push({ mode, color: rgbInt(darker(color, 1 - 0.26 * fx.brush.wet)), pts, w: w.map((v) => v * 1.0), a: a.map((v) => v * 0.5) });
    out.runs.push({ mode, color: rgbInt(color), pts, w: w.map((v) => v * 0.68), a: a.map((v) => Math.min(1, v * 0.62)) });
    out.segments += 2 * (n - 1);
  } else if (s.tool === TOOL.charcoal) {
    out.runs.push({ mode, color: rgbInt(color), pts, w: w.map((v) => v * 0.9), a: a.map((v) => v * 0.55) });
    const j: number[] = [];
    for (let k = 0; k < n; k++) {
      const jx = (hash(k, seed, 31) - 0.5) * base * 0.7 * fx.charcoal.grain;
      const jy = (hash(k, seed, 32) - 0.5) * base * 0.7 * fx.charcoal.grain;
      j.push(pts[k * 2] + jx, pts[k * 2 + 1] + jy);
    }
    out.runs.push({ mode, color: rgbInt(color), pts: j, w: w.map((v) => Math.max(0.5, v * 0.45)), a: a.map((v) => v * 0.35) });
    out.segments += 2 * (n - 1);
  } else {
    out.runs.push({ mode, color: rgbInt(color), pts, w, a });
    out.segments += n - 1;
    if (ink.gold) {
      out.runs.push({ mode: 1, color: rgbInt(mixRGB(color, [255, 244, 200], 0.6)), pts, w: w.map((v) => Math.max(0.5, v * 0.35)), a: a.map((v) => v * 0.55) });
      out.segments += n - 1;
    }
  }
  // kaňka: brk občas ukápne na začátku tahu (stejně při každém vykreslení)
  if (s.tool === TOOL.pen && !ink.even && hash(seed, Math.floor(s.p.length / 3) * 3, 17) < fx.pen.blot) {
    const r = (base / 2) * (1.8 + hash(seed, 1, 18) * 1.4);
    out.dots.push({ mode: mode === 0 ? 0 : 1, color: rgbInt(color), alpha: Math.min(1, op), x: s.p[0], y: s.p[1], r });
  }
}

/** celá kresba; eps = tolerance zjednodušení v logických px (0 = plná kvalita) */
export function drawingOps(d: Drawing, eps = 0): Ops {
  const out: Ops = { runs: [], dots: [], segments: 0 };
  d.strokes.forEach((s, i) => strokeOps(s, d, i + 1, eps, out));
  return out;
}

// ---------------------------------------------------------------------------
// plán pro Gizmos: lomené čáry seskupené podle barvy, krytí a šířky (jedna kresba Gizmos = jedna barva a šířka v px)

export interface GizmoGroup {
  color: number; // 0xRRGGBB
  alpha: number; // 0..1
  width: number; // logické px listu
  chains: number[][]; // lomené čáry x, y, ... (logické px)
}

export interface GizmoPlan {
  groups: GizmoGroup[];
  units: number; // úseky čar včetně skrytých spojek mezi tahy
  ids: number; // kolik kreseb Gizmos plán potřebuje (max 256 bodů na kresbu)
}

export const GIZMO_MAX_POINTS = 256;
/** na kolik kreseb Gizmos se rozdělí lomená čára z n bodů (navazují: každá další začíná posledním bodem předchozí) */
export const chunks = (n: number) => (n <= 1 ? 0 : Math.ceil((n - 1) / (GIZMO_MAX_POINTS - 1)));

// šířky čar v px obrazovky (Gizmos: 0,5 až 8 px) a krytí po skupinách - čím méně skupin, tím méně kreseb Gizmos
const PX = [0.5, 1, 1.5, 2, 3, 4, 6, 8];
const bucketPx = (px: number) => {
  for (let i = 0; i < PX.length - 1; i++) if (px < (PX[i] + PX[i + 1]) / 2) return i;
  return PX.length - 1;
};
const ALPHAS = [0.3, 0.6, 0.92];
const bucketA = (a: number) => (a < 0.45 ? 0 : a < 0.76 ? 1 : 2);
/** barvy na dálku splývají: 5 bitů na složku od 0,7 logického px na px, 4 bity od 1,5 */
function quantColor(c: number, k: number): number {
  if (k < 0.7) return c;
  const bits = k < 1.5 ? 3 : 4;
  const q = (v: number) => Math.min(255, ((v >> bits) << bits) + (1 << (bits - 1)));
  return (q((c >> 16) & 255) << 16) | (q((c >> 8) & 255) << 8) | q(c & 255);
}

/**
 * eps = tolerance zjednodušení (logické px), minWidth = tah užší než tohle (logické px) vypadne,
 * k = logických px listu na 1 px obrazovky (podle vzdálenosti) - podle něj se tahy seskupí na šířky v px.
 * maxIds = strop kreseb Gizmos pro tenhle list (výchozí podle k: zblízka 72, středně 32, daleko 16).
 */
export function gizmoPlan(d: Drawing, eps: number, minWidth = 0, k = 1, maxIds?: number): GizmoPlan {
  const ops = drawingOps(d, eps);
  const groups = new Map<string, GizmoGroup>();
  for (const r of ops.runs) {
    if (r.mode === 2 && eps > 0) continue; // seškrábání se na dálku neukazuje
    const n = r.w.length;
    if (!n) continue;
    let ws = 0;
    let as = 0;
    for (let i = 0; i < n; i++) {
      ws += r.w[i];
      as += r.a[i];
    }
    const wAvg = ws / n;
    if (wAvg < minWidth) continue;
    const pb = bucketPx(wAvg / k);
    // užší než 0,5 px (nejtenčí čára Gizmos): stejná čára, jen slabší - jako pokrytí pixelu
    const ab = bucketA((as / n) * Math.max(0.3, Math.min(1, wAvg / k / 0.5)));
    const color = quantColor(r.color, k);
    const key = color + ":" + ab + ":" + pb;
    let g = groups.get(key);
    if (!g) {
      g = { color, alpha: ALPHAS[ab], width: PX[pb] * k, chains: [] };
      groups.set(key, g);
    }
    g.chains.push(r.pts);
  }
  const list = [...groups.values()];
  merge(list, maxIds ?? (k < 0.7 ? 72 : k < 1.5 ? 32 : 16));
  let units = 0;
  let ids = 0;
  for (const g of list) {
    units += unitsOf(g);
    ids += idsOf(g);
  }
  return { groups: list, units, ids };
}

const pointsOf = (g: GizmoGroup) => g.chains.reduce((n, c) => n + c.length / 2, 0);
const unitsOf = (g: GizmoGroup) => pointsOf(g) - g.chains.length + Math.max(0, g.chains.length - 1) * 3;
const idsOf = (g: GizmoGroup) => chunks(pointsOf(g) + (g.chains.length - 1) * 2);

/** nejmenší skupiny se přelijí do nejpodobnější (barva, krytí, šířka), dokud se kresba nevejde do maxIds */
function merge(list: GizmoGroup[], maxIds: number) {
  let ids = list.reduce((n, g) => n + idsOf(g), 0);
  while (ids > maxIds && list.length > 1) {
    let si = 0;
    for (let i = 1; i < list.length; i++) if (pointsOf(list[i]) < pointsOf(list[si])) si = i;
    const g = list[si];
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < list.length; i++) {
      if (i === si) continue;
      const o = list[i];
      const dr = ((g.color >> 16) & 255) - ((o.color >> 16) & 255);
      const dg = ((g.color >> 8) & 255) - ((o.color >> 8) & 255);
      const db = (g.color & 255) - (o.color & 255);
      const d = Math.sqrt(dr * dr + dg * dg + db * db) + 120 * Math.abs(g.alpha - o.alpha) + 25 * Math.abs(Math.log2(g.width / o.width));
      if (d < bd) (bd = d), (best = i);
    }
    const o = list[best];
    const before = idsOf(g) + idsOf(o);
    o.chains.push(...g.chains);
    list.splice(si, 1);
    ids += idsOf(o) - before;
  }
}

export const SHEET = { w: SRC_W, h: SRC_H };
