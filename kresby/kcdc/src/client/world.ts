// Kresby ve světě: vývěsky a stojany kolem hráče, kresby na nich jako nativní 3D čáry (Gizmos, hloubkový test
// proti scéně), LOD, rozpočet, mezipaměť dat a živé kreslení ostatních.
//
// KCDC neumí dynamickou texturu na entitě ani obrázek ve světě z dat za běhu, takže kresba je z čar:
// * list = vyplněný čtyřúhelník barvy papíru (všechny listy v dosahu v jedné meshi Gizmos podle druhu papíru);
// * tahy = lomené čáry seskupené podle barvy, krytí a šířky (jedna kresba Gizmos = jedna barva a šířka);
//   mezi tahy jedné skupiny vede spojka "po rubu" listu (za lícem desky), kterou zakryje deska ve scéně;
// * LOD: tolerance zjednodušení a nejmenší šířka podle toho, kolik logických px listu připadá na 1 px obrazovky;
// * rozpočet: Gizmos má 16 384 úseků pro všechny resources a 128 kreseb na resource. Kresby si berou
//   CFG.gizmoUnits / gizmoIds, nejbližší listy první; co se nevejde, dostane hrubší LOD, nebo jen papír.
// * data kreseb se stahují až zblízka (drawRange + 8 m), podle otisku, mezipaměť LRU omezená bajty.

import { emitServer } from "./net";
import { MAX_INKS, decode, type Drawing } from "../shared/codec";
import { paperOf, rgbInt } from "../shared/ink";
import { LOOK } from "../shared/look";
import { axes, pickSlot, sheetPoint, slots, viewPoint, type Face, type Slot, type V3 } from "../shared/layout";
import { EV, LIMITS, type BoardMsg, type DataMsg, type LiveMsg, type OkoliMsg } from "../shared/protocol";
import { GIZMO_MAX_POINTS, gizmoPlan, type GizmoPlan } from "../shared/vector";
import { caption } from "../shared/popisky";

export interface ClientCfg {
  /** textura = listy staví server jako osvětlené Prop s texturou (tady nic); cary / oboji = ladicí čáry Gizmos */
  rezim: "textura" | "cary" | "oboji";
  platno: "auto" | "nativni" | "web";
  gizmoUnits: number;
  gizmoIds: number;
  drawRange: number;
  paperRange: number;
  cacheBytes: number;
  useKey: string;
}

export const cfg: ClientCfg = { rezim: "textura", platno: "auto", gizmoUnits: 6000, gizmoIds: 96, drawRange: 14, paperRange: 40, cacheBytes: 8 * 1024 * 1024, useKey: "f" };

const log = (t: string) => console.log("[kresby] " + t);

interface Board {
  m: BoardMsg;
  face: Face;
  ax: { u: V3; v: V3 };
  slots: Slot[];
}

interface Entry {
  d: Drawing;
  bytes: number;
  plans: Map<number, GizmoPlan>;
}

const boards = new Map<number, Board>();
const cache = new Map<string, Entry>(); // otisk -> kresba (LRU: poslední použitá na konci)
let cacheBytes = 0;
const asked = new Map<string, number>(); // otisk -> kdy jsme o něj žádali
const waiting = new Set<string>(); // ve frontě na EV.chci
// "deska:list" -> cizí kreslení naživo; reset se zvýší při zpět / nové relaci (pak se list kreslí znovu celý),
// přidané tahy reset nemění (dokreslí se do dalších kreseb Gizmos, viz render)
const live = new Map<string, { s: number; e: Entry; reset: number }>();
/** reset roste přes všechny relace (i po konci a nové relaci): podpis se nesmí opakovat, jinak zůstane vzatý tah */
let liveSeq = 0;
let ownSlot = ""; // list, na který právě kreslím já (kreslí ho plátno)
export const stats = { units: 0, ids: 0, sheets: 0, drawn: 0, plans: 0, planMs: 0, setMs: 0, requests: 0, appends: 0, rebuilds: 0 };

const key = (b: number, s: number) => b + ":" + s;

function boardOf(m: BoardMsg): Board {
  const face: Face = { pos: m.pos, n: m.n, w: m.w, h: m.h, cols: m.cols, rows: m.rows };
  return { m, face, ax: axes(m.n), slots: m.kind === "kram" ? [] : slots(face) };
}

export function onOkoli(m: OkoliMsg) {
  for (const id of m.del ?? []) {
    boards.delete(id);
    for (const k of [...live.keys()]) if (k.startsWith(id + ":")) live.delete(k);
  }
  for (const b of m.add ?? []) boards.set(b.id, boardOf(b));
}

export function onDeska(m: BoardMsg) {
  boards.set(m.id, boardOf(m));
}

export function setOwnSlot(b: number | null, s = 0) {
  ownSlot = b === null ? "" : key(b, s);
}

export const boardById = (id: number) => boards.get(id) ?? null;

// ---------------------------------------------------------------------------
// data kreseb

function remember(h: string, d: Drawing, size: number) {
  const old = cache.get(h);
  if (old) cacheBytes -= old.bytes;
  const e: Entry = { d, bytes: size * 6 + 512, plans: new Map() };
  cache.delete(h);
  cache.set(h, e);
  cacheBytes += e.bytes;
  while (cacheBytes > cfg.cacheBytes && cache.size > 1) {
    const [k, v] = cache.entries().next().value as [string, Entry];
    cache.delete(k);
    cacheBytes -= v.bytes;
  }
  return e;
}

export function onData(m: DataMsg) {
  if (!m || typeof m.h !== "string") return;
  waiting.delete(m.h);
  if (m.retry) {
    asked.set(m.h, Date.now() - 9000); // zkusit znovu za ~1 s
    return;
  }
  const d = m.d ? decode(m.d) : null;
  if (d) remember(m.h, d, m.d!.length);
  else asked.set(m.h, Date.now() + 60000); // neznámá / zabavená: chvíli se neptat
}

/** kresba podle otisku, z mezipaměti nebo z dat, která už máme (prohlížení) */
export function entryOf(h: string): Entry | null {
  const e = cache.get(h);
  if (e) {
    cache.delete(h);
    cache.set(h, e);
  }
  return e ?? null;
}

export function put(h: string, data: string): Drawing | null {
  const e = entryOf(h);
  if (e) return e.d;
  const d = decode(data);
  if (d) remember(h, d, data.length);
  return d;
}

function want(h: string) {
  if (cache.has(h) || waiting.has(h)) return;
  const t = asked.get(h) ?? 0;
  if (Date.now() - t < 10000) return;
  waiting.add(h);
}

function request() {
  if (!waiting.size) return;
  const list = [...waiting].filter((h) => Date.now() - (asked.get(h) ?? 0) >= 10000).slice(0, LIMITS.dataBatch);
  if (!list.length) return;
  for (const h of list) asked.set(h, Date.now());
  stats.requests++;
  emitServer(EV.chci, { h: list });
}

// ---------------------------------------------------------------------------
// živé kreslení ostatních

export function onLive(m: LiveMsg) {
  const k = key(m.b, m.slot);
  if (m.end) return void live.delete(k);
  let l = live.get(k);
  if (m.inks || !l || l.s !== m.s) {
    l = { s: m.s, e: { d: { paper: m.paper ?? 0, inks: m.inks ?? [], strokes: [] }, bytes: 0, plans: new Map() }, reset: ++liveSeq };
    live.set(k, l);
  }
  if (m.undo) {
    l.e.d.strokes.splice(Math.max(0, l.e.d.strokes.length - m.undo), m.undo);
    l.reset = ++liveSeq;
  }
  const add = m.add ? decode(m.add, MAX_INKS) : null;
  if (add) l.e.d.strokes.push(...add.strokes);
  l.e.plans.clear(); // plány celé kresby (přestavba) neplatí; nové tahy si render dokreslí sám
}

// ---------------------------------------------------------------------------
// vykreslení

interface Shown {
  sig: string;
  ids: string[];
  /** kolik tahů kresby je nakreslených (živé kreslení: další se dokreslí do nových kreseb Gizmos) */
  n: number;
  units: number;
  parts: number;
  /** kdy se list naposled kreslil celý (živé kreslení: přestavba nejvýš jednou za sekundu) */
  full: number;
  level: number;
}
const shown = new Map<string, Shown>(); // list -> co z něj právě kreslíme
const paperShown = new Map<number, string>(); // druh papíru -> podpis meshe

const sub = (a: V3, b: { x: number; y: number; z: number }) => [a[0] - b.x, a[1] - b.y, a[2] - b.z] as V3;

function argb(rgb: number, a: number) {
  return ((Math.round(Math.max(0, Math.min(1, a)) * 255) << 24) | rgb) >>> 0;
}

/** úroveň LOD z poměru k = logických px listu na 1 px obrazovky (po půlkách oktávy) */
const levelOf = (k: number) => Math.max(-4, Math.min(14, Math.round(Math.log2(Math.max(1e-3, k)) * 2)));
const kOf = (level: number) => 2 ** (level / 2);

/** podpis nakreslené podoby: kresba (u živé relace + reset), LOD a šířka čáry v px (mění se se vzdáleností: překreslit
 * při změně o víc než ~30 %) */
const sigOf = (h: string, level: number, lk: number) => h + ":" + level + ":" + Math.round(Math.log2(lk / kOf(level)) * 3);

function planOf(e: Entry, level: number): GizmoPlan {
  let p = e.plans.get(level);
  if (!p) {
    const t = Date.now();
    const k = kOf(level);
    p = gizmoPlan(e.d, level <= -2 ? 0 : 0.5 * k, 0.08 * k, k);
    e.plans.set(level, p);
    stats.plans++;
    stats.planMs += Date.now() - t;
  }
  return p;
}

function setGizmo(id: string, prim: Parameters<typeof Gizmos.set>[1], style: Parameters<typeof Gizmos.set>[2]) {
  try {
    Gizmos.set(id, prim, style);
    return true;
  } catch (e) {
    log(`gizmo ${id}: ${String(e)}`);
    return false;
  }
}

function drawSheet(b: Board, si: number, plan: GizmoPlan, k: number, d: number, part = ""): string[] {
  const ids: string[] = [];
  const s = b.slots[si];
  const off = 0.012 + d * 0.0009;
  const back = -0.035;
  const P = (x: number, y: number, o: number) => {
    const p = sheetPoint(b.face, s, b.ax, x, y, o);
    return { x: p[0], y: p[1], z: p[2] };
  };
  plan.groups.forEach((g, gi) => {
    const pts: { x: number; y: number; z: number }[] = [];
    g.chains.forEach((c, ci) => {
      if (ci > 0) {
        const prev = g.chains[ci - 1];
        pts.push(P(prev[prev.length - 2], prev[prev.length - 1], back), P(c[0], c[1], back));
      }
      for (let i = 0; i < c.length; i += 2) pts.push(P(c[i], c[i + 1], off));
    });
    const width = Math.max(0.5, Math.min(8, g.width / k));
    const style = { color: argb(g.color, g.alpha), width };
    for (let c = 0, start = 0; start < pts.length - 1; c++, start += GIZMO_MAX_POINTS - 1) {
      const id = `k${b.m.id}_${si}${part}_${gi}_${c}`;
      if (setGizmo(id, { type: "polyline", points: pts.slice(start, start + GIZMO_MAX_POINTS) }, style)) ids.push(id);
    }
  });
  return ids;
}

function clearSheet(k: string) {
  const s = shown.get(k);
  if (!s) return;
  for (const id of s.ids) {
    try {
      Gizmos.remove(id);
    } catch {
      /* už není */
    }
  }
  shown.delete(k);
}

interface Cand {
  b: Board;
  si: number;
  k: string;
  d: number;
  e: Entry | null;
  h: string;
  paper: number;
  lk: number; // logických px na 1 px obrazovky
}

/** jeden průchod vykreslení (po 250 ms) */
let drewLines = false;

export function render() {
  // režim textura: kresby ve světě jsou osvětlené listy (Prop s texturou ze serveru). Čarami (Gizmos) se kreslí jen
  // to, co textura ještě neukazuje: list, na který se právě kreslí (tahy naživo), a hotová kresba, jejíž textura
  // se ještě peče / balíček se přenačítá (`pend`). Pak čáry zmizí a zůstane stínovaná textura.
  const jenCekajici = cfg.rezim === "textura";
  if (jenCekajici && drewLines) {
    clearAll(); // přepnuto z režimu čar: pryč i s papíry
    drewLines = false;
  }
  if (!jenCekajici) drewLines = true;
  const pose = Camera.getPose();
  if (!pose) return;
  const t0 = Date.now();
  const cam = pose.position;
  const fwd = pose.forward;
  const screenH = Math.max(480, Web.getScreenSize().height);
  const tanH = Math.tan(((pose.fov || 55) / 2) * (Math.PI / 180));
  const cosView = Math.cos(Math.atan(tanH * Math.hypot(1, pose.aspectRatio || 1.78)) + 0.25);
  const cands: Cand[] = [];
  for (const b of boards.values()) {
    b.slots.forEach((s, si) => {
      const sm = b.m.slots[si];
      if (!sm) return;
      if (jenCekajici && !(sm.live || (sm.h && sm.pend))) return;
      const k = key(b.m.id, si);
      if (k === ownSlot) return;
      const c = sheetPoint(b.face, s, b.ax, 384, 256, 0);
      const rel = sub(c, cam);
      const d = Math.hypot(rel[0], rel[1], rel[2]);
      if (d > cfg.paperRange) return;
      if (-(rel[0] * b.face.n[0] + rel[1] * b.face.n[1] + rel[2] * b.face.n[2]) < 0) return; // díváme se na rub
      if (d > 2 && (rel[0] * fwd.x + rel[1] * fwd.y + rel[2] * fwd.z) / d < cosView) return; // mimo záběr
      let e: Entry | null = null;
      let h = "";
      if (sm.live) {
        const l = live.get(k);
        if (l) (e = l.e), (h = "live" + l.s + ":" + l.reset);
      } else if (sm.h) {
        h = sm.h;
        e = cache.get(sm.h) ?? null;
        if (!e && d <= cfg.drawRange + 8) want(sm.h);
      }
      const lk = ((2 * Math.max(0.3, d) * tanH) / screenH) / (s.w / 768);
      cands.push({ b, si, k, d, e, h, paper: sm.paper, lk });
    });
  }
  cands.sort((a, b) => a.d - b.d);

  // papír: všechny listy v dosahu, jedna mesh na druh papíru (4 body, 2 trojúhelníky = 6 úseků na list)
  let units = 0;
  let ids = 0;
  for (const kind of LOOK.papers.map((p) => p.kod)) {
    const list = jenCekajici ? [] : cands.filter((c) => c.paper === kind).slice(0, 255); // v režimu textura je papír Prop
    const sig = list.map((c) => c.k).join(",");
    if (paperShown.get(kind) === sig) {
      if (sig) (units += list.length * 6), ids++;
      continue;
    }
    paperShown.set(kind, sig);
    const id = "papir" + kind;
    if (!list.length) {
      try {
        Gizmos.remove(id);
      } catch {
        /* nebyla */
      }
      continue;
    }
    const points: { x: number; y: number; z: number }[] = [];
    const indices: number[] = [];
    for (const c of list) {
      const s = c.b.slots[c.si];
      const o = 0.006 + c.d * 0.0006;
      const n = points.length;
      for (const [x, y] of [[0, 0], [768, 0], [768, 512], [0, 512]]) {
        const p = sheetPoint(c.b.face, s, c.b.ax, x, y, o);
        points.push({ x: p[0], y: p[1], z: p[2] });
      }
      indices.push(n, n + 1, n + 2, n, n + 2, n + 3);
    }
    if (points.length >= 3 && setGizmo(id, { type: "mesh", points, indices, wireframe: false }, { fillColor: argb(rgbInt(paperOf(kind).rgb), 1), color: 0x00000000 })) {
      units += list.length * 6;
      ids++;
    }
  }

  // tahy: nejbližší listy první, co se nevejde, hrubší LOD
  const keep = new Set<string>();
  let drawn = 0;
  const now = Date.now();
  for (const c of cands) {
    if (!c.e || c.d > cfg.drawRange || !c.e.d.strokes.length) continue;
    const n = c.e.d.strokes.length;
    const prev = shown.get(c.k);
    // živé kreslení: nové tahy se naplánují samy a dokreslí do dalších kreseb Gizmos; celý list se přestaví po zpět,
    // při změně LOD a nejvýš jednou za sekundu, když dokreslených kreseb Gizmos přibývá (spojí se zpátky)
    // a jen na úrovni, kterou chce vzdálenost: hrubší LOD vynucený dřív rozpočtem se tu jinak nikdy nezjemní
    const same = prev !== undefined && prev.level === levelOf(c.lk) && prev.sig === sigOf(c.h, prev.level, c.lk);
    if (same && prev!.n === n && c.h.startsWith("live") && units + prev!.units <= cfg.gizmoUnits && ids + prev!.ids.length <= cfg.gizmoIds) {
      // živý list beze změny: plány celé kresby se po každé zprávě zahazují, tak je nepočítat znovu
      units += prev!.units;
      ids += prev!.ids.length;
      keep.add(c.k);
      drawn++;
      continue;
    }
    if (same && prev!.n < n && (prev!.parts < 8 || now - prev!.full < 1000)) {
      const sh = prev!;
      const k = kOf(sh.level);
      const t = Date.now();
      const p = gizmoPlan(c.e.d, sh.level <= -2 ? 0 : 0.5 * k, 0.08 * k, k, undefined, sh.n);
      stats.planMs += Date.now() - t;
      if (units + sh.units + p.units <= cfg.gizmoUnits && ids + sh.ids.length + p.ids <= cfg.gizmoIds) {
        const t2 = Date.now();
        sh.ids.push(...drawSheet(c.b, c.si, p, c.lk, c.d, "x" + ++sh.parts));
        stats.setMs += Date.now() - t2;
        sh.units += p.units;
        sh.n = n;
        stats.appends++;
        units += sh.units;
        ids += sh.ids.length;
        keep.add(c.k);
        drawn++;
        continue;
      }
    }
    let level = levelOf(c.lk);
    let plan: GizmoPlan | null = null;
    for (let tries = 0; tries < 4; tries++, level += 2) {
      const p = planOf(c.e, level);
      if (units + p.units <= cfg.gizmoUnits && ids + p.ids <= cfg.gizmoIds) {
        plan = p;
        break;
      }
    }
    if (!plan) continue;
    const sig = sigOf(c.h, level, c.lk);
    keep.add(c.k);
    drawn++;
    if (prev?.sig === sig && prev.n === n) {
      units += prev.units;
      ids += prev.ids.length;
      continue;
    }
    units += plan.units;
    ids += plan.ids;
    clearSheet(c.k);
    const t = Date.now();
    shown.set(c.k, { sig, ids: drawSheet(c.b, c.si, plan, c.lk, c.d), n, units: plan.units, parts: 0, full: now, level });
    stats.setMs += Date.now() - t;
    stats.rebuilds++;
  }
  for (const k of [...shown.keys()]) if (!keep.has(k)) clearSheet(k);
  stats.units = units;
  stats.ids = ids;
  stats.sheets = cands.length;
  stats.drawn = drawn;
  request();
  void t0;
}

export function clearAll() {
  for (const k of [...shown.keys()]) clearSheet(k);
  paperShown.clear();
  try {
    Gizmos.clear();
  } catch {
    /* nic */
  }
}

// ---------------------------------------------------------------------------
// na co se hráč dívá (deska / list / krám) - pro nápovědu akce a klávesu

export interface Target {
  b: number;
  slot: number;
  text: string;
}

export function target(range = 4.5): Target | null {
  const ray = Camera.screenRay({ range });
  const pose = Camera.getPose();
  if (!ray || !pose) return null;
  const o: V3 = [ray.origin.x, ray.origin.y, ray.origin.z];
  const dir: V3 = [ray.direction.x, ray.direction.y, ray.direction.z];
  let best: Target | null = null;
  let bd = Infinity;
  for (const b of boards.values()) {
    const rel = sub(b.m.pos, pose.position);
    const d = Math.hypot(rel[0], rel[1], rel[2]);
    if (d > range + Math.max(b.m.w, b.m.h)) continue;
    if (b.m.kind === "kram") {
      if (d < 3 && d < bd) (bd = d), (best = { b: b.m.id, slot: 0, text: "Písař: koupit potřeby ke kreslení" });
      continue;
    }
    if (b.m.own) continue; // deska jiného resource (škola): ovládá ji on
    const hit = pickSlot(b.face, o, dir, range);
    if (!hit || hit.dist >= bd) continue;
    bd = hit.dist;
    const sm = b.m.slots[hit.slot];
    const text = sm?.live ? "Na list se právě kreslí" : sm?.h ? `Prohlédnout „${caption(sm.t ?? "Kresba", sm.t ?? "Kresba", sm.h)}“` : b.m.kind === "stojan" ? "Stojan: kreslit" : "Vývěska: kreslit nebo připíchnout";
    best = { b: b.m.id, slot: hit.slot, text };
  }
  return best;
}

// ---------------------------------------------------------------------------
// ladění: obrysy desek a listů

export function outlines(ms: number) {
  let n = 0;
  for (const b of boards.values()) {
    if (n++ >= 20) break;
    const P = (a: number, c: number) => {
      const p: V3 = [
        b.face.pos[0] + b.ax.u[0] * a + b.ax.v[0] * c + b.face.n[0] * 0.02,
        b.face.pos[1] + b.ax.u[1] * a + b.ax.v[1] * c + b.face.n[1] * 0.02,
        b.face.pos[2] + b.ax.u[2] * a + b.ax.v[2] * c + b.face.n[2] * 0.02,
      ];
      return { x: p[0], y: p[1], z: p[2] };
    };
    const w = b.face.w / 2;
    const h = b.face.h / 2;
    setGizmo("ladit" + b.m.id, { type: "polyline", points: [P(-w, -h), P(w, -h), P(w, h), P(-w, h)], closed: true }, { color: 0xffffaa00, width: 2, depthTest: false, durationMs: ms });
    const pts: { x: number; y: number; z: number }[] = [];
    for (const s of b.slots) pts.push(P(s.cx - s.w / 2, s.cy - s.h / 2), P(s.cx + s.w / 2, s.cy - s.h / 2), P(s.cx + s.w / 2, s.cy + s.h / 2), P(s.cx - s.w / 2, s.cy + s.h / 2), P(s.cx - s.w / 2, s.cy - s.h / 2));
    if (pts.length >= 2) setGizmo("laditL" + b.m.id, { type: "polyline", points: pts.slice(0, 256) }, { color: 0xff6ee678, width: 1.5, depthTest: false, durationMs: ms });
  }
}



/** kamera na list desky (čtení zblízka): odkud a kam se dívat; null = deska neznámá */
export function sheetShot(boardId: number, slot: number, fov: number, aspect: number): { eye: V3; at: V3 } | null {
  const b = boards.get(boardId);
  const s = b?.slots[slot];
  if (!b || !s) return null;
  const eye = viewPoint(b.face, s, fov, aspect, 0.86);
  return { eye, at: sheetPoint(b.face, s, b.ax, 384, 256, 0) };
}
