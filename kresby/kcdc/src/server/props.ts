// Listy na deskách jako Prop ve světě: model listu s texturou kresby (server/assets.ts), osvětlený hrou a se stíny.
// Prop streamuje KCDC sám podle vzdálenosti (interest grid) a hra kreslí model se svými mipmapami a LOD - žádné
// vlastní LOD v klientu. Kreslí se jen v režimu "textura" / "oboji"; režim "cary" nechá ladicí čáry klienta.

import { axes, quatFromBasis, slots, type V3 } from "../shared/layout";
export { quatFromBasis };
import * as assets from "./assets";
import { SHEET_W } from "./cgf";
import { CFG } from "./config";
import type { BoardRec } from "./store";

interface Placed {
  prop: Prop;
  model: string;
  key: string;
}

const placed = new Map<string, Placed>(); // "deska:list" -> Prop
const retry = new Set<number>(); // desky, kde se list nepostavil (balíček se teprve balí): zkusit znovu
const log = (t: string) => console.log("[kresby] " + t);
export const stats = { spawned: 0, failed: 0 };

/** kde a jak list stojí: střed, natočení, měřítko (model je 1 m široký) */
export function placement(b: BoardRec, slot: number) {
  const face = { pos: b.pos, n: b.n, w: b.w, h: b.h, cols: b.cols, rows: b.rows };
  const s = slots(face)[slot];
  const ax = axes(b.n);
  const off = CFG.svet.odsazeni;
  const pos: V3 = [
    b.pos[0] + ax.u[0] * s.cx + ax.v[0] * s.cy + b.n[0] * off,
    b.pos[1] + ax.u[1] * s.cx + ax.v[1] * s.cy + b.n[1] * off,
    b.pos[2] + ax.u[2] * s.cx + ax.v[2] * s.cy + b.n[2] * off,
  ];
  return { pos, q: quatFromBasis(ax.u, ax.v, b.n), scale: s.w / SHEET_W };
}

const textures = () => CFG.svet.rezim !== "cary";

function spawn(b: BoardRec, slot: number, model: string): Prop | null {
  const pl = placement(b, slot);
  try {
    const prop = Prop.spawn(model, new Vector3(pl.pos[0], pl.pos[1], pl.pos[2]), new Quaternion(pl.q[0], pl.q[1], pl.q[2], pl.q[3]), pl.scale, "none");
    stats.spawned++;
    return prop;
  } catch (e) {
    stats.failed++;
    log(`list ${b.id}/${slot} (${model}): ${String(e)}`);
    return null;
  }
}

/** desku srovná: co visí (a nekreslí se), má Prop s aktuálním modelem; ostatní pryč */
export function sync(b: BoardRec, liveSlots: (slot: number) => boolean) {
  if (b.kind === "kram") return;
  for (let i = 0; i < b.slots.length; i++) {
    const key = b.id + ":" + i;
    const s = b.slots[i];
    const drawing = !!s && !s.hid;
    const blank = liveSlots(i); // někdo kreslí: čistý list
    let want: string | null = null;
    if (textures() && (drawing || blank)) want = assets.modelFor(drawing ? s!.d : null, s?.p ?? 0).model;
    const cur = placed.get(key);
    if (cur && cur.model === want) continue;
    if (want) {
      const prop = spawn(b, i, want);
      if (!prop) retry.add(b.id);
      if (!prop && cur) continue; // nový model nejde (balíček se právě restartuje): nechat starý
      cur?.prop.destroy();
      if (prop) placed.set(key, { prop, model: want, key });
      else placed.delete(key);
    } else if (cur) {
      cur.prop.destroy();
      placed.delete(key);
    }
  }
  for (const [key, p] of placed) {
    const [bid, si] = key.split(":").map(Number);
    if (bid === b.id && si >= b.slots.length) {
      p.prop.destroy();
      placed.delete(key);
    }
  }
}

/** desky s nepostaveným listem znovu (KCDC zabalí assety až po resourceStart balíčku, viz AGENTS.md) */
export function retryFailed(get: (id: number) => BoardRec | undefined, liveSlots: (b: BoardRec, slot: number) => boolean) {
  const ids = [...retry];
  retry.clear();
  for (const id of ids) {
    const b = get(id);
    if (b) sync(b, (slot) => liveSlots(b, slot));
  }
}

export function removeBoard(id: number) {
  for (const [key, p] of placed) {
    if (Number(key.split(":")[0]) !== id) continue;
    try {
      p.prop.destroy();
    } catch {
      /* už není */
    }
    placed.delete(key);
  }
}

export function destroyAll() {
  for (const p of placed.values()) {
    try {
      p.prop.destroy();
    } catch {
      /* resource končí */
    }
  }
  placed.clear();
}

export const count = () => placed.size;
