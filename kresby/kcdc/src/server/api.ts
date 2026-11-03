// API kreseb pro jiné resources (manifest exports): desky, které vlastní jiný modul (škola: tabule, čítanky a písanky
// na stolech), kreslení pro vybraného hráče bez materiálu a kresby vložené skriptem (ručně psaný text z písma).
//
// Deska s `owner` se nepoužívá přes nabídku kreseb (nejde z ní strhnout ani na ni kreslit bez relace vlastníka).
// Hotová kresba visí na listu desky jako každá jiná: upeče se do stínované textury (balíček textur, ~30 s).
//
//   boardCreate({ owner, kind?, pos, n, w, h?, cols?, rows?, yaw?, model? })  -> id | "chyba"
//   boardRemove(id, owner)                                                    -> boolean
//   boardDraw(playerId, id, slot, { owner, paper?, inks, tools?, base?, title?, hang?, done? }) -> Promise<true | "chyba">
//   boardPut(id, slot, "k3.", { owner, title?, author? })                     -> id kresby | "chyba"
//   boardClear(id, slot, owner)                                               -> boolean
//   boardGet(id, slot)                                                        -> Promise<{ d, t, a, id } | null>
//   boardInfo(id)                                                             -> { pos, n, w, h, cols, rows, slots: [{ d?, t? } | null], live: number[] } | null
//   paperCode("tabule")                                                       -> kód listu nebo -1
//   stopDrawing(playerId)                                                     -> boolean (ukončí relaci bez uložení)
//   drawingPrepare(owner, "k3.", { title?, author? })                         -> id sdílené kresby | "chyba"
//   boardShow(id, slot, drawingId, owner)                                     -> Promise<true | "chyba">
//   drawingReady(drawingId)                                                   -> boolean (textura je v běžícím balíčku)
//   drawingDelete(drawingId, owner)                                           -> boolean
//   boardBake(id, slot, owner)                                                -> boolean (upéct po bake:false)
// Hotovo: callback `done` z boardDraw (FreeResult) a událost mezi resources "kresby:hotovo" (owner, FreeResult).
//
// Sdílená (připravená) kresba se upeče jednou a může viset na libovolně deskách vlastníka zároveň: jedna textura
// pro všechny čítanky na stolech, připravená tabule se ukáže bez čekání. S listem se nemaže, jen drawingDelete.

import { countPoints, decode, hashOf, type Ink, type Stroke } from "../shared/codec";
import { faceHeight, type V3 } from "../shared/layout";
import { LOOK } from "../shared/look";
import { create, liveAt, remove, changed } from "./boards";
import { CFG } from "./config";
import { cleanTitle } from "./drawings";
import * as assets from "./assets";
import { dropDrawing, end, replaceSlot, sessionOfPlayer, startFree, type FreeResult } from "./sessions";
import { boards, getDrawing, newId, putDrawing, type DrawingRec } from "./store";

const log = (t: string) => console.log("[kresby] " + t);
const isV3 = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export interface BoardSpec {
  owner: string;
  kind?: "deska" | "stojan";
  pos: V3;
  n: V3;
  w: number;
  h?: number;
  cols?: number;
  rows?: number;
  yaw?: number;
  model?: string | null;
}

export function boardCreate(spec: BoardSpec): number | string {
  if (!spec || typeof spec.owner !== "string" || !spec.owner) return "Chybí vlastník desky (owner).";
  if (!isV3(spec.pos) || !isV3(spec.n)) return "Poloha a normála desky jsou trojice čísel.";
  const w = Math.max(0.1, Math.min(6, Number(spec.w) || 1));
  const cols = Math.max(1, Math.min(8, Math.floor(Number(spec.cols) || 1)));
  const rows = Math.max(1, Math.min(8, Math.floor(Number(spec.rows) || 1)));
  const h = Number(spec.h) > 0 ? Math.min(6, Number(spec.h)) : faceHeight(w, cols, rows);
  const kind = spec.kind === "stojan" ? "stojan" : "deska";
  const r = create(kind, { pos: spec.pos, n: norm(spec.n), w, h, cols, rows }, spec.owner, {
    owner: spec.owner,
    ...(kind === "stojan" ? { yaw: Number(spec.yaw) || 0, model: spec.model ?? CFG.stojan.model } : {}),
  });
  if (typeof r === "string") return r;
  return r.id;
}

const owned = (id: unknown, owner: unknown) => {
  const b = boards.get(Number(id));
  return b && b.owner && b.owner === owner ? b : null;
};

export function boardRemove(id: number, owner: string): boolean {
  const b = owned(id, owner);
  if (!b) return false;
  for (let i = 0; i < b.slots.length; i++) stopAt(b.id, i);
  for (const s of b.slots) if (s && !s.k) dropDrawing(s.d);
  remove(b);
  return true;
}

function stopAt(board: number, slot: number) {
  for (const p of Player.all()) {
    const s = sessionOfPlayer(p);
    if (s && (s as any).b.id === board && (s as any).slot === slot) end(s as any, "Deska zmizela.");
  }
}

export interface DrawOpts {
  owner: string;
  paper?: number;
  inks: (Ink & { name?: string; pick?: boolean })[]; // name na plátně; pick:false = jen pro předlohu, psát jím nejde
  tools?: number[];
  base?: string | null; // "k3." předloha / dosavadní obsah (null = čistý list)
  title?: string;
  hang?: boolean;
  bake?: boolean; // false = nepéct hned (klienti kresbu kreslí čarami), upéct až boardBake (např. konec hodiny)
  done?: (r: FreeResult) => void;
}

export async function boardDraw(playerId: number, id: number, slot: number, o: DrawOpts): Promise<true | string> {
  const p = Player.getById(playerId);
  if (!p) return "Hráč není připojený.";
  const b = owned(id, o?.owner);
  if (!b) return "Deska není (nebo patří jinému resource).";
  const inks = (Array.isArray(o.inks) ? o.inks : []).slice(0, 16).map((i) => ({
    rgb: [0, 1, 2].map((k) => Math.max(0, Math.min(255, Math.round(Number(i?.rgb?.[k]) || 0)))) as [number, number, number],
    flags: Math.max(0, Math.min(3, Math.round(Number(i?.flags) || 0))),
    strength: Math.max(1, Math.min(255, Math.round(Number(i?.strength) || 255))),
    ...(typeof i?.name === "string" ? { name: i.name } : {}),
    ...(i?.pick === false ? { pick: false } : {}),
  }));
  let base: Stroke[] = [];
  let paper = Number.isInteger(o.paper) ? Number(o.paper) : 0;
  if (o.base) {
    const d = decode(o.base, 16);
    if (!d) return "Předloha není platná kresba.";
    base = d.strokes;
    if (!Number.isInteger(o.paper)) paper = d.paper;
  }
  const r = await startFree(p, b, Math.floor(slot), paper, {
    owner: o.owner,
    inks,
    tools: (Array.isArray(o.tools) ? o.tools : [0]).filter((t) => t >= 0 && t <= 3),
    base,
    title: o.title ?? "Kresba",
    hang: o.hang !== false,
    bake: o.bake !== false,
    done: typeof o.done === "function" ? o.done : undefined,
  });
  return r === true ? true : typeof r === "string" ? r : "Kreslení nejde otevřít.";
}

export function boardPut(id: number, slot: number, data: string, o: { owner: string; title?: string; author?: string; bake?: boolean }): number | string {
  const b = owned(id, o?.owner);
  if (!b) return "Deska není (nebo patří jinému resource).";
  if (!(slot >= 0 && slot < b.slots.length)) return "List na desce není.";
  if (liveAt(b, slot)) return "Na list se právě kreslí.";
  const rec = record(data, o);
  if (typeof rec === "string") return rec;
  replaceSlot(b, slot, rec, o.bake !== false);
  return rec.id;
}

/** upéct texturu kresby na listu (po boardDraw / boardPut s bake:false); true = peče se nebo už je */
export function boardBake(id: number, slot: number, owner: string): boolean {
  const s = owned(id, owner)?.slots[slot];
  if (!s) return false;
  void assets.want(s.d);
  return true;
}

function record(data: string, o: { owner: string; title?: string; author?: string }, keep = false): DrawingRec | string {
  const d = decode(data, 16);
  if (!d) return "Neplatná kresba.";
  return {
    id: newId(),
    h: hashOf(data),
    d: data,
    t: cleanTitle(o.title ?? "Text"),
    a: String(o.author ?? ""),
    u: "",
    s: !!o.author,
    p: d.paper,
    c: Date.now(),
    n: countPoints(d),
    o: o.owner,
    ...(keep ? { k: 1 as const } : {}),
  };
}

/** sdílená kresba: uloží se a upeče do textury hned (bez listu); visí přes boardShow */
export function drawingPrepare(owner: string, data: string, o: { title?: string; author?: string } = {}): number | string {
  if (typeof owner !== "string" || !owner) return "Chybí vlastník (owner).";
  const rec = record(data, { ...o, owner }, true);
  if (typeof rec === "string") return rec;
  putDrawing(rec);
  void assets.want(rec.id);
  return rec.id;
}

export async function boardShow(id: number, slot: number, drawingId: number, owner: string): Promise<true | string> {
  const b = owned(id, owner);
  if (!b) return "Deska není (nebo patří jinému resource).";
  if (!(slot >= 0 && slot < b.slots.length)) return "List na desce není.";
  if (liveAt(b, slot)) return "Na list se právě kreslí.";
  const rec = await getDrawing(Number(drawingId));
  if (!rec || rec.o !== owner || !rec.k) return "Sdílená kresba není (drawingPrepare).";
  if (b.slots[slot]?.d === rec.id) return true;
  replaceSlot(b, slot, rec);
  return true;
}

export const drawingReady = (drawingId: number) => !!assets.shardOf(Number(drawingId));

export async function drawingDelete(drawingId: number, owner: string): Promise<boolean> {
  const rec = await getDrawing(Number(drawingId));
  if (!rec || rec.o !== owner || !rec.k) return false;
  for (const b of boards.values()) {
    let hit = false;
    b.slots.forEach((s, i) => {
      if (s?.d === rec.id) (b.slots[i] = null), (hit = true);
    });
    if (hit) changed(b);
  }
  dropDrawing(rec.id);
  return true;
}

export function boardClear(id: number, slot: number, owner: string): boolean {
  const b = owned(id, owner);
  if (!b || !b.slots[slot]) return false;
  stopAt(b.id, slot);
  const old = b.slots[slot]!;
  b.slots[slot] = null;
  if (!old.k) dropDrawing(old.d);
  changed(b);
  return true;
}

export async function boardGet(id: number, slot: number): Promise<{ id: number; d: string; t: string; a: string } | null> {
  const s = boards.get(Number(id))?.slots[slot];
  if (!s) return null;
  const r = await getDrawing(s.d);
  return r ? { id: r.id, d: r.d, t: r.t, a: r.s ? r.a : "" } : null;
}

export function boardInfo(id: number) {
  const b = boards.get(Number(id));
  if (!b) return null;
  return {
    pos: b.pos, n: b.n, w: b.w, h: b.h, cols: b.cols, rows: b.rows, owner: b.owner ?? null,
    slots: b.slots.map((s) => (s ? { d: s.d, t: s.t } : null)),
    live: b.slots.map((_, i) => liveAt(b, i)),
  };
}

export const paperCode = (id: string) => LOOK.papers.find((p) => p.id === id)?.kod ?? -1;

export function stopDrawing(playerId: number): boolean {
  const p = Player.getById(playerId);
  const s = p && sessionOfPlayer(p);
  if (!s) return false;
  end(s, "Kreslení ukončeno.");
  return true;
}

export function registerApi() {
  const api: Record<string, (...a: any[]) => unknown> = {
    boardCreate, boardRemove, boardDraw, boardPut, boardClear, boardGet, boardInfo, paperCode, stopDrawing,
    drawingPrepare, boardShow, drawingReady, drawingDelete, boardBake,
  };
  // chyba se volajícímu vrací vždy jako text (ne výjimka ani odmítnutý promise), i u asynchronních exportů
  const fail = (name: string, e: unknown) => {
    log(`${name}: ${String(e)}`);
    return String(e);
  };
  for (const [name, fn] of Object.entries(api)) {
    Exports.register(name, (...a: any[]) => {
      try {
        const r = fn(...a);
        return r && typeof (r as Promise<unknown>).then === "function" ? (r as Promise<unknown>).catch((e) => fail(name, e)) : r;
      } catch (e) {
        return fail(name, e);
      }
    });
  }
}

