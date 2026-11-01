// Úložiště kreseb a desek nad most.storage (klíč-hodnota, JSON).
//
//   kresby:meta              { v: 1, next }               počítadlo id
//   kresby:deska/<id>        BoardRec                     vývěska / stojan / krám, i s pověšenými listy (bez dat kresby)
//   kresby:kresba/<id>       DrawingRec                   kresba (data "k3."), jen pověšené a velké kresby z brašny
//
// Desky se načtou při startu celé (stovky × ~1 kB). Kresby až na vyžádání (otisk -> id ze slotu desky), drží se
// v LRU mezipaměti omezené bajty. Zápisy se slučují (CFG.saveMs), takže kreslení ani věšení úložiště nezahltí.

import type { BoardKind } from "../shared/protocol";
import type { V3 } from "../shared/layout";
import { CFG } from "./config";
import { storage } from "./most";

export interface DrawingRec {
  id: number;
  h: string; // otisk dat
  d: string; // "k3." (nebo "k2." z KCD:MP)
  t: string; // název
  a: string; // jméno autora (postava)
  u: string; // id postavy autora
  s: boolean; // podepsaná
  p: number; // papír 0 pergamen, 1 papír
  c: number; // kdy vznikla (ms)
  n: number; // bodů
  hid?: boolean; // zabavená moderátorem
  o?: string; // vlastník (resource přes server/api.ts)
  k?: 1; // sdílená / připravená kresba jiného resource: smaže se jen výslovně (drawingDelete), ne s listem
}

export interface SlotRec {
  d: number; // id kresby
  h: string;
  t: string;
  a: string; // podpis ("" = nepodepsáno)
  u: string;
  p: number;
  hid?: boolean;
  k?: 1; // sdílená kresba (DrawingRec.k): s listem se nemaže
}

export interface BoardRec {
  id: number;
  kind: BoardKind;
  pos: V3;
  n: V3;
  w: number;
  h: number;
  cols: number;
  rows: number;
  slots: (SlotRec | null)[];
  by: string; // kdo ji postavil
  c: number;
  yaw?: number; // stojan: natočení modelu
  model?: string | null; // stojan: herní model (Prop)
  owner?: string; // deska jiného resource (server/api.ts): hráči ji nepoužívají přes nabídku kreseb
}

const KEY = {
  meta: "kresby:meta",
  board: (id: number) => "kresby:deska/" + id,
  drawing: (id: number) => "kresby:kresba/" + id,
};

const log = (t: string) => console.log("[kresby] " + t);

export const boards = new Map<number, BoardRec>();
let next = 1;
let loaded = false;

const dirty = new Map<string, unknown>(); // klíč -> hodnota (null = smazat)
let timer: ReturnType<typeof setTimeout> | null = null;
let writes = 0;

// LRU kreseb: Map drží pořadí vložení, poslední použitá jde na konec
const cache = new Map<number, DrawingRec>();
let cacheBytes = 0;
const byHash = new Map<string, number>(); // otisk -> id kresby (známé z desek a uložených kreseb)

export function stats() {
  return { boards: boards.size, cached: cache.size, cacheBytes, writes, pending: dirty.size, hashes: byHash.size, storage: storage.kind() };
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => void flush(), CFG.saveMs);
}

function put(key: string, value: unknown) {
  dirty.set(key, value);
  schedule();
}

/** hodnota jiné části modulu (stav textur, server/assets.ts) se stejným slučováním zápisů (CFG.saveMs) */
export function saveLater(key: string, value: unknown) {
  put(key, value);
}

export async function flush(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const batch = [...dirty];
  dirty.clear();
  for (const [k, v] of batch) {
    try {
      if (v === null) await storage.delete(k);
      else if (!(await storage.set(k, v as any))) log("úložiště odmítlo " + k);
      writes++;
    } catch (e) {
      log(`zápis ${k}: ${String(e)}`);
    }
  }
}

export async function load(): Promise<void> {
  boards.clear();
  byHash.clear();
  const meta = (await storage.get(KEY.meta)) as { next?: number } | undefined;
  next = Math.max(1, Number(meta?.next) || 1);
  const keys = await storage.keys("kresby:deska/");
  for (const k of keys) {
    const b = (await storage.get(k)) as BoardRec | undefined;
    if (!b || typeof b.id !== "number" || !Array.isArray(b.pos)) continue;
    boards.set(b.id, b);
    next = Math.max(next, b.id + 1);
    for (const s of b.slots) {
      if (s) {
        byHash.set(s.h, s.d);
        next = Math.max(next, s.d + 1);
      }
    }
  }
  loaded = true;
  log(`načteno ${boards.size} desek (úložiště: ${storage.kind()})`);
}

export const isLoaded = () => loaded;

export function newId(): number {
  const id = next++;
  put(KEY.meta, { v: 1, next });
  return id;
}

export function saveBoard(b: BoardRec) {
  boards.set(b.id, b);
  for (const s of b.slots) if (s) byHash.set(s.h, s.d);
  put(KEY.board(b.id), b);
}

export function deleteBoard(id: number) {
  boards.delete(id);
  put(KEY.board(id), null);
}

function remember(rec: DrawingRec) {
  const old = cache.get(rec.id);
  if (old) {
    cacheBytes -= old.d.length;
    cache.delete(rec.id);
  }
  cache.set(rec.id, rec);
  cacheBytes += rec.d.length;
  byHash.set(rec.h, rec.id);
  while (cacheBytes > CFG.cacheBytes && cache.size > 1) {
    const [k, v] = cache.entries().next().value as [number, DrawingRec];
    cache.delete(k);
    cacheBytes -= v.d.length;
  }
}

export function putDrawing(rec: DrawingRec) {
  remember(rec);
  put(KEY.drawing(rec.id), rec);
}

export async function getDrawing(id: number): Promise<DrawingRec | null> {
  const c = cache.get(id);
  if (c) {
    cache.delete(id);
    cache.set(id, c);
    return c;
  }
  const pending = dirty.get(KEY.drawing(id));
  const rec = (pending !== undefined ? pending : await storage.get(KEY.drawing(id))) as DrawingRec | null | undefined;
  if (!rec || typeof rec.d !== "string") return null;
  remember(rec);
  return rec;
}

export async function getByHash(h: string): Promise<DrawingRec | null> {
  const id = byHash.get(h);
  return id === undefined ? null : getDrawing(id);
}

/** kresba z dat předmětu, která není v úložišti: podrží se v mezipaměti, aby ji šlo poslat divákům */
export function rememberTransient(rec: DrawingRec) {
  remember(rec);
}

export function updateDrawing(rec: DrawingRec) {
  putDrawing(rec);
}

export function deleteDrawing(id: number) {
  const c = cache.get(id);
  if (c) {
    cache.delete(id);
    cacheBytes -= c.d.length;
  }
  // otisk -> id: stejný obsah může mít i jiná kresba (stejný text na víc deskách); pak ukázat na ni
  for (const [h, x] of byHash) {
    if (x !== id) continue;
    let jina: number | undefined;
    for (const b of boards.values()) for (const s of b.slots) if (s && s.h === h && s.d !== id) jina = s.d;
    if (jina !== undefined) byHash.set(h, jina);
    else byHash.delete(h);
  }
  put(KEY.drawing(id), null);
}

/** jen pro testy: zapomenout vše v paměti (jako po restartu serveru) */
export function resetMemory() {
  boards.clear();
  cache.clear();
  byHash.clear();
  cacheBytes = 0;
  loaded = false;
}
