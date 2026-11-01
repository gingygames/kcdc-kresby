// Vývěsky, stojany a krámy ve světě + kdo o nich ví.
//
// Vývěska je rovina na povrchu, kam se správce díval (World.raycast přes jeho klienta): herní vývěska, zeď, deska.
// Stojan je herní model podstavce (Prop, streamuje se sám): dřevěná tabule na sloupku nebo malířský stojan; kde je
// na něm líc a jak je model natočený, říká shared/stojany.ts (změřeno z geometrie), jiné modely CFG.stojan.
// Krám je jen bod (nápověda akce v klientu otevře obchod).
//
// Zájem: server má mřížku 32 m a každých CFG.streamMs pošle každému hráči rozdíl desek do CFG.streamRange
// (EV.okoli). Změna desky jde jen těm, kdo o ní vědí (EV.deska). Obsah kreseb si klient stahuje sám až zblízka
// (EV.chci), takže hráč, který jde kolem, dostane jen pár set bajtů popisu desek.

import { licStojanu, pataStojanu, stojanPro } from "../shared/stojany";
import { faceHeight, type Face, type V3 } from "../shared/layout";
import { EV, type BoardKind, type BoardMsg, type OkoliMsg } from "../shared/protocol";
import * as assets from "./assets";
import { CFG } from "./config";
import { LOOK } from "../shared/look";
import * as sheets from "./props";
import { boards, deleteBoard, newId, saveBoard, type BoardRec } from "./store";

const CELL = 32;
const grid = new Map<string, Set<number>>();
const known = new Map<number, Set<number>>(); // hráč -> desky, o kterých ví
const welcomed = new Set<number>();
const props = new Map<number, Prop>();
const live = new Map<string, number>(); // "deska:slot" -> relace kreslení

const log = (t: string) => console.log("[kresby] " + t);
const cellKey = (x: number, y: number) => Math.floor(x / CELL) + "," + Math.floor(y / CELL);

import { sendTo } from "./net";
export { sendTo };

export function faceOf(b: BoardRec): Face {
  return { pos: b.pos, n: b.n, w: b.w, h: b.h, cols: b.cols, rows: b.rows };
}

function index(b: BoardRec) {
  const k = cellKey(b.pos[0], b.pos[1]);
  let s = grid.get(k);
  if (!s) grid.set(k, (s = new Set()));
  s.add(b.id);
}

function unindex(b: BoardRec) {
  grid.get(cellKey(b.pos[0], b.pos[1]))?.delete(b.id);
}

export function boardMsg(b: BoardRec): BoardMsg {
  return {
    id: b.id,
    kind: b.kind,
    pos: b.pos,
    n: b.n,
    w: b.w,
    h: b.h,
    cols: b.cols,
    rows: b.rows,
    rev: 0,
    ...(b.owner ? { own: 1 as const } : {}),
    slots: b.slots.map((s, i) => {
      const l = live.get(b.id + ":" + i);
      if (l) return { live: l, paper: 0 };
      if (!s || s.hid) return null;
      const o = assets.shardOf(s.d);
      return { h: s.h, t: s.t, a: s.a || undefined, paper: s.p, o, d: s.d, ...(!o && assets.isEnabled() ? { pend: 1 as const } : {}) };
    }),
  };
}

export function near(pos: { x: number; y: number; z: number }, range: number, kind?: BoardKind): BoardRec[] {
  const out: BoardRec[] = [];
  const r = Math.ceil(range / CELL);
  const cx = Math.floor(pos.x / CELL);
  const cy = Math.floor(pos.y / CELL);
  for (let i = -r; i <= r; i++) {
    for (let j = -r; j <= r; j++) {
      for (const id of grid.get(cx + i + "," + (cy + j)) ?? []) {
        const b = boards.get(id);
        if (!b || (kind && b.kind !== kind)) continue;
        if (Math.hypot(b.pos[0] - pos.x, b.pos[1] - pos.y, b.pos[2] - pos.z) <= range) out.push(b);
      }
    }
  }
  return out.sort((a, c) => dist(a, pos) - dist(c, pos));
}

export const dist = (b: BoardRec, pos: { x: number; y: number; z: number }) => Math.hypot(b.pos[0] - pos.x, b.pos[1] - pos.y, b.pos[2] - pos.z);

/** EV.okoli pro jednoho hráče (volá se po CFG.streamMs) */
export function stream(p: Player) {
  let k = known.get(p.id);
  if (!k) known.set(p.id, (k = new Set()));
  const now = new Set(near(p.position, CFG.streamRange).map((b) => b.id));
  const add: BoardMsg[] = [];
  const del: number[] = [];
  for (const id of now) if (!k.has(id)) add.push(boardMsg(boards.get(id)!));
  for (const id of k) if (!now.has(id)) del.push(id);
  const first = !welcomed.has(p.id);
  if (!add.length && !del.length && !first) return;
  known.set(p.id, now);
  const msg: OkoliMsg & { cfg?: unknown } = { add, del };
  if (first) {
    welcomed.add(p.id);
    msg.cfg = clientCfg();
  }
  sendTo(p, EV.okoli, msg);
}

export function streamAll() {
  for (const p of Player.all()) if (p.ready !== false) stream(p);
}

export function forget(p: Player) {
  known.delete(p.id);
  welcomed.delete(p.id);
}

/** nastavení klienta: CFG.klient + režim světa + vzhled (papíry, efekty) - posílá se v první zprávě okolí a po změně */
export function clientCfg() {
  return { ...CFG.klient, rezim: CFG.svet.rezim, vzhled: LOOK };
}

/** nové nastavení klientům, kteří už o kresbách vědí */
export function broadcastCfg() {
  for (const p of Player.all()) if (welcomed.has(p.id)) sendTo(p, EV.okoli, { add: [], del: [], cfg: clientCfg() });
}

/** změna desky: těm, kdo o ní vědí (a listy ve světě) */
export function changed(b: BoardRec, persist = true) {
  sheets.sync(b, (slot) => liveAt(b, slot) > 0);
  if (persist) saveBoard(b);
  const msg = boardMsg(b);
  for (const p of Player.all()) if (known.get(p.id)?.has(b.id)) sendTo(p, EV.deska, msg);
}

export function setLive(b: BoardRec, slot: number, session: number | null) {
  const k = b.id + ":" + slot;
  if (session) live.set(k, session);
  else live.delete(k);
  changed(b, false);
}

export const liveAt = (b: BoardRec, slot: number) => live.get(b.id + ":" + slot) ?? 0;

/** kdo vidí desku (pro živé kreslení): hráči do CFG.liveRange */
export function viewers(b: BoardRec, except?: number): Player[] {
  const out: Player[] = [];
  for (const p of Player.all()) {
    if (p.id === except) continue;
    if (dist(b, p.position) <= CFG.liveRange && known.get(p.id)?.has(b.id)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// stavba

/** podstavec modelu: známé modely z geometrie (shared/stojany.ts), jiné podle nastavení CFG.stojan */
const podstavec = (model: string | null | undefined) => stojanPro(model) ?? { ...CFG.stojan, bok: 0 };

function spawnProp(b: BoardRec) {
  if (b.kind !== "stojan" || !b.model) return;
  try {
    const st = podstavec(b.model);
    const pata = pataStojanu(st, b.pos, b.n);
    const prop = Prop.spawn(b.model, { x: pata[0], y: pata[1], z: pata[2] }, new Vector3(0, 0, (b.yaw ?? 0) + st.yaw));
    props.set(b.id, prop);
  } catch (e) {
    log(`stojan ${b.id}: model ${b.model}: ${String(e)}`);
  }
}

export function indexAll() {
  grid.clear();
  for (const b of boards.values()) {
    index(b);
    spawnProp(b);
    sheets.sync(b, (slot) => liveAt(b, slot) > 0);
  }
}

export function create(kind: BoardKind, face: Face, by: string, extra: Partial<BoardRec> = {}): BoardRec | string {
  if (boards.size >= CFG.maxBoards) return `Desek je už ${boards.size}, víc nastavení nedovolí (maxBoards).`;
  const n = kind === "kram" ? 0 : Math.max(1, Math.min(CFG.maxSlots, face.cols * face.rows));
  const b: BoardRec = {
    id: newId(),
    kind,
    pos: face.pos.map((v) => Math.round(v * 1000) / 1000) as V3,
    n: face.n.map((v) => Math.round(v * 10000) / 10000) as V3,
    w: face.w,
    h: face.h,
    cols: kind === "kram" ? 0 : face.cols,
    rows: kind === "kram" ? 0 : Math.ceil(n / face.cols),
    slots: new Array(n).fill(null),
    by,
    c: Date.now(),
    ...extra,
  };
  saveBoard(b);
  index(b);
  spawnProp(b);
  for (const p of Player.all()) stream(p);
  return b;
}

/** přesun / změna rozměrů desky (nastavení ve správě): mřížka zájmu, stojan, listy, klienti */
export function relocate(b: BoardRec, ch: Partial<Pick<BoardRec, "pos" | "n" | "w" | "h" | "cols" | "rows" | "kind" | "yaw">>) {
  unindex(b);
  props.get(b.id)?.destroy();
  props.delete(b.id);
  sheets.removeBoard(b.id);
  Object.assign(b, ch);
  if (b.kind !== "kram") {
    const n = Math.max(1, Math.min(CFG.maxSlots, b.cols * b.rows));
    if (b.slots.length !== n) b.slots = Array.from({ length: n }, (_, i) => b.slots[i] ?? null);
  }
  index(b);
  spawnProp(b);
  // klientům: deska zmizí a přijde znovu s novou polohou
  for (const p of Player.all()) {
    const k = known.get(p.id);
    if (k?.delete(b.id)) sendTo(p, EV.okoli, { add: [], del: [b.id] } as OkoliMsg);
  }
  changed(b);
  for (const p of Player.all()) stream(p);
}

export function remove(b: BoardRec) {
  unindex(b);
  props.get(b.id)?.destroy();
  sheets.removeBoard(b.id);
  props.delete(b.id);
  deleteBoard(b.id);
  for (const p of Player.all()) {
    const k = known.get(p.id);
    if (k?.delete(b.id)) sendTo(p, EV.okoli, { add: [], del: [b.id] } as OkoliMsg);
  }
}

export function destroyProps() {
  for (const p of props.values()) {
    try {
      p.destroy();
    } catch {
      /* resource končí */
    }
  }
  props.clear();
}

/** kam se hráč dívá: povrch do 6 m (World.raycast jeho klientem), jinak 1,5 m před ním svisle */
export async function aim(p: Player): Promise<{ pos: V3; n: V3; hit: boolean }> {
  const eye = { x: p.position.x, y: p.position.y, z: p.position.z + 1.6 };
  const d = p.lookDirection ?? { x: 0, y: 1, z: 0 };
  try {
    const r = await World.raycast(p, new Vector3(eye.x, eye.y, eye.z), new Vector3(eye.x + d.x * 6, eye.y + d.y * 6, eye.z + d.z * 6), { mode: "cover" });
    if (r.answered && r.hit) {
      const n = r.hit.normal;
      // líc svisle, když povrch je skoro svislý (herní vývěsky bývají mírně nakloněné - ty se nechají)
      const nn: V3 = Math.abs(n.z) < 0.08 ? norm([n.x, n.y, 0]) : [n.x, n.y, n.z];
      const h = r.hit.position;
      return { pos: [h.x + nn[0] * 0.01, h.y + nn[1] * 0.01, h.z + nn[2] * 0.01], n: nn, hit: true };
    }
  } catch (e) {
    log("raycast: " + String(e));
  }
  const f = norm([d.x, d.y, 0]);
  return { pos: [eye.x + f[0] * 1.5, eye.y + f[1] * 1.5, eye.z - 0.1], n: [-f[0], -f[1], 0], hit: false };
}

function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** stojan: podstavec 1,2 m před hráčem (dřevěná tabule: deska vedle sloupku), lícem k němu */
export function easelFace(p: Player, width = stojanPro(CFG.stojan.model)?.sirka ?? CFG.stojan.width): { face: Face; yaw: number } {
  const d = p.lookDirection ?? { x: 0, y: 1, z: 0 };
  const f = norm([d.x, d.y, 0]);
  const yaw = (Math.atan2(-f[0], f[1]) * 180) / Math.PI + 180; // líc proti hráči
  const st = podstavec(CFG.stojan.model);
  const w = Math.min(width, stojanPro(CFG.stojan.model)?.sirka ?? width);
  // list uprostřed před hráčem: pata podstavce se posune o bok (deska visí vedle sloupku)
  const lic = licStojanu(st, [0, 0, 0], yaw);
  const pos: V3 = [p.position.x + f[0] * 1.2 + lic.n[0] * st.forward, p.position.y + f[1] * 1.2 + lic.n[1] * st.forward, p.position.z + st.up];
  return { face: { pos, n: lic.n, w, h: Math.min(faceHeight(w, 1, 1), stojanPro(CFG.stojan.model)?.vyska ?? 9), cols: 1, rows: 1 }, yaw: Math.round(yaw * 10) / 10 };
}
