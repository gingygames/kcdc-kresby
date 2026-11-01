// Geometrie vývěsky a stojanu: rovina ve světě (střed líce, normála) a rozložení listů. Sdílí server i klient.
//
// Osy líce: n = kam líc hledí (k divákovi), u = doprava z pohledu diváka, v = nahoru po líci. Svět má Z nahoru.
// List: logické px x 0..768 zleva, y 0..512 shora (jako v KCD:MP), poměr 3 : 2.

export type V3 = [number, number, number];

export interface Face {
  pos: V3; // střed líce (m)
  n: V3; // jednotková normála líce
  w: number; // šířka (m)
  h: number; // výška (m)
  cols: number;
  rows: number;
}

export interface Slot {
  cx: number; // střed listu od středu líce po u (m)
  cy: number; // ... po v (m)
  w: number; // šířka listu (m)
  h: number; // výška listu (m)
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const v3 = { sub, dot, cross, norm };

/** osy líce: u doprava, v nahoru (u svislé normály se vezme sever) */
export function axes(n: V3): { u: V3; v: V3 } {
  const f: V3 = [-n[0], -n[1], -n[2]];
  let u = cross(f, [0, 0, 1]);
  if (Math.hypot(u[0], u[1], u[2]) < 1e-4) u = [1, 0, 0];
  u = norm(u);
  return { u, v: norm(cross(u, f)) };
}

/** normála svislé desky natočené o yaw stupňů (0 = líc k +Y, jako hráč KCD2) a nakloněné o tilt (horní hrana dozadu) */
export function normalFromYaw(yawDeg: number, tiltDeg = 0): V3 {
  const a = (yawDeg * Math.PI) / 180;
  const t = (tiltDeg * Math.PI) / 180;
  return norm([-Math.sin(a) * Math.cos(t), Math.cos(a) * Math.cos(t), Math.sin(t)]);
}

/** výška líce pro mřížku listů 3 : 2 se stejným okrajem, když ji správce nezadá */
export function faceHeight(w: number, cols: number, rows: number): number {
  const m = w * 0.05;
  const cell = (w - 2 * m) / cols;
  return Math.round((rows * (cell / 1.5) + 2 * m) * 1000) / 1000;
}

export function slots(f: Face): Slot[] {
  const m = Math.min(f.w, f.h) * 0.05;
  const gap = Math.min(f.w, f.h) * 0.03;
  const cw = (f.w - 2 * m - gap * (f.cols - 1)) / f.cols;
  const ch = (f.h - 2 * m - gap * (f.rows - 1)) / f.rows;
  const sw = Math.min(cw, ch * 1.5);
  const sh = sw / 1.5;
  const out: Slot[] = [];
  for (let r = 0; r < f.rows; r++) {
    for (let c = 0; c < f.cols; c++) {
      out.push({
        cx: -f.w / 2 + m + c * (cw + gap) + cw / 2,
        cy: f.h / 2 - m - r * (ch + gap) - ch / 2,
        w: sw,
        h: sh,
      });
    }
  }
  return out;
}

/** bod listu (logické px) -> svět; off = odsazení od líce po normále (m) */
export function sheetPoint(f: Face, s: Slot, ax: { u: V3; v: V3 }, x: number, y: number, off: number): V3 {
  const a = s.cx + (x / 768 - 0.5) * s.w;
  const b = s.cy + (0.5 - y / 512) * s.h;
  return [
    f.pos[0] + ax.u[0] * a + ax.v[0] * b + f.n[0] * off,
    f.pos[1] + ax.u[1] * a + ax.v[1] * b + f.n[1] * off,
    f.pos[2] + ax.u[2] * a + ax.v[2] * b + f.n[2] * off,
  ];
}

/** střed listu ve světě */
export function slotCenter(f: Face, s: Slot, off = 0): V3 {
  return sheetPoint(f, s, axes(f.n), 384, 256, off);
}

/** odkud se na list dívat, aby ho kamera měla celý (svislé zorné pole fov°, poměr stran aspect) */
export function viewPoint(f: Face, s: Slot, fov: number, aspect: number, fill = 0.82): V3 {
  const t = Math.tan(((fov / 2) * Math.PI) / 180);
  const byH = s.h / 2 / (t * fill);
  const byW = s.w / 2 / (t * aspect * fill);
  const d = Math.max(byH, byW, 0.25);
  const c = slotCenter(f, s);
  return [c[0] + f.n[0] * d, c[1] + f.n[1] * d, c[2] + f.n[2] * d];
}

/** je bod p před lícem a dost blízko? vrací vzdálenost od líce nebo -1 */
export function inFront(f: Face, p: V3, range: number): number {
  const d = sub(p, f.pos);
  const along = dot(d, f.n);
  if (along < -0.2 || Math.hypot(d[0], d[1], d[2]) > range) return -1;
  return along;
}

/** paprsek (origin, dir) proti líci: index listu, který zasáhne, nebo -1 */
export function pickSlot(f: Face, origin: V3, dir: V3, range: number): { slot: number; dist: number } | null {
  const denom = dot(dir, f.n);
  if (denom > -1e-4) return null; // míří od líce
  const t = dot(sub(f.pos, origin), f.n) / denom;
  if (t < 0 || t > range) return null;
  const hit: V3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
  const ax = axes(f.n);
  const rel = sub(hit, f.pos);
  const a = dot(rel, ax.u);
  const b = dot(rel, ax.v);
  if (Math.abs(a) > f.w / 2 + 0.05 || Math.abs(b) > f.h / 2 + 0.05) return null;
  const list = slots(f);
  let best = -1;
  let bd = Infinity;
  list.forEach((s, i) => {
    const d = Math.hypot(a - s.cx, b - s.cy);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return { slot: best, dist: t };
}

/** kvaternion (w, x, y, z) z matice se sloupci u (osa X modelu), v (Y), n (Z) */
export function quatFromBasis(u: V3, v: V3, n: V3): [number, number, number, number] {
  const m00 = u[0], m01 = v[0], m02 = n[0];
  const m10 = u[1], m11 = v[1], m12 = n[1];
  const m20 = u[2], m21 = v[2], m22 = n[2];
  const tr = m00 + m11 + m22;
  let w: number, x: number, y: number, z: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = s / 4;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = s / 4;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = s / 4;
  }
  const l = Math.hypot(w, x, y, z) || 1;
  return [w / l, x / l, y / l, z / l];
}

