// Hotové kresby: předmět v brašně, prohlížení, věšení na vývěsku a strhávání, nabídka u desky, moderace
// a posílání obsahu kreseb klientům (na vyžádání, s limitem rychlosti).
//
// Kresba v brašně je vlastní předmět kresby:kresba. Malá kresba (do CFG.itemDataMax znaků, běžně tisíce bodů
// díky kodeku k3) má data přímo v datech předmětu - přežije s inventářem frameworku a nepotřebuje úložiště.
// Větší kresba je v úložišti a předmět nese jen odkaz (id + otisk). Pověšená kresba je vždy v úložišti.

import { decode, encodeK3, hashOf, countPoints, type Drawing } from "../shared/codec";
import { caption } from "../shared/popisky";
import { slots } from "../shared/layout";
import { EV, LIMITS, type DataMsg, type ViewMsg } from "../shared/protocol";
import * as assets from "./assets";
import { changed, dist, faceOf, liveAt, sendTo } from "./boards";
import { CFG } from "./config";
import { ITEM, guidOf, kindOf, openShop, sheetsOf } from "./materials";
import * as most from "./most";
import { start as startSession, sessionOfPlayer } from "./sessions";
import { boards as allBoards, deleteDrawing, getByHash, getDrawing, newId, putDrawing, rememberTransient, type BoardRec, type DrawingRec, type SlotRec } from "./store";

export interface ItemData {
  v: 1;
  id: number;
  h: string;
  t: string;
  a: string;
  u: string;
  s: boolean;
  p: number;
  c: number;
  n: number;
  k?: string; // data kresby, vejde-li se
}

export function cleanTitle(s: unknown): string {
  let t = String(s ?? "")
    .replace(/[\u0000-\u001f<>]/g, "")
    .trim();
  if (!t) return "Kresba";
  if ([...t].length > LIMITS.titleLen) t = [...t].slice(0, LIMITS.titleLen).join("");
  return t;
}

function itemText(r: { s: boolean; a: string; p: number }): string {
  const by = r.s ? "Podepsáno: " + r.a : "Nepodepsáno.";
  const on = r.p === 1 ? "Kresba na archu papíru." : "Kresba na kusu pergamenu.";
  return `${on} ${by} Použij ji, chceš-li si ji prohlédnout. U vývěsky ji jde připíchnout.`; // jeden řádek (KCDC odmítá \n)
}

export async function makeRecord(p: Player, d: Drawing, title: string, signed: boolean): Promise<DrawingRec> {
  const data = encodeK3(d);
  return {
    id: newId(),
    h: hashOf(data),
    d: data,
    t: cleanTitle(title),
    a: await most.charName(p),
    u: await most.charId(p),
    s: signed,
    p: d.paper,
    c: Date.now(),
    n: countPoints(d),
  };
}

/** dá hráči kresbu jako předmět; malá kresba nese data s sebou, velká jde do úložiště */
export function giveDrawing(p: Player, rec: DrawingRec): boolean {
  const data: ItemData = { v: 1, id: rec.id, h: rec.h, t: rec.t, a: rec.a, u: rec.u, s: rec.s, p: rec.p, c: rec.c, n: rec.n };
  if (rec.d.length <= CFG.itemDataMax) data.k = rec.d;
  else putDrawing(rec);
  const ok = most.giveCustom(p, guidOf(ITEM.kresba), { name: rec.t, description: itemText(rec), data: data as unknown as Record<string, unknown> });
  if (!ok && data.k) {
    // framework / limit odmítl data v předmětu: kresba do úložiště, předmět jen s odkazem
    delete data.k;
    putDrawing(rec);
    return most.giveCustom(p, guidOf(ITEM.kresba), { name: rec.t, description: itemText(rec), data: data as unknown as Record<string, unknown> });
  }
  return ok;
}

export function itemDrawings(p: Player): { row: string; data: ItemData }[] {
  const out: { row: string; data: ItemData }[] = [];
  for (const r of most.rows(p)) {
    if (kindOf(r) !== ITEM.kresba) continue;
    const d = most.customData(r) as ItemData | null;
    if (d && typeof d.h === "string") out.push({ row: r.id, data: d });
  }
  return out;
}

/** záznam kresby z předmětu (data v předmětu, nebo úložiště) */
export async function recordOfItem(d: ItemData): Promise<DrawingRec | null> {
  if (d.k) {
    const rec: DrawingRec = { id: d.id, h: d.h, d: d.k, t: d.t, a: d.a, u: d.u, s: d.s, p: d.p, c: d.c, n: d.n };
    if (hashOf(d.k) !== d.h || !decode(d.k)) return null;
    return rec;
  }
  return getDrawing(d.id);
}

function viewMsg(r: DrawingRec, p: Player): ViewMsg {
  return { title: citelne(p, r.t, r.h), author: r.s ? citelne(p, r.a, r.h + "a") : "", h: r.h, d: r.d, paper: r.p };
}

/** název a podpis tak, jak je hráč přečte (filtr popisků jiného resource, např. škola); seed = otisk kresby */
export const citelne = (p: Player, text: string, seed: string) => caption(text, p.id, text, seed);

export async function viewItem(p: Player, row: InventoryRow) {
  const d = most.customData(row) as ItemData | null;
  const rec = d && (await recordOfItem(d));
  if (!rec) return void most.notify(p, "Kresba je rozmazaná, nejde rozeznat.", "warning");
  if (rec.hid) return void most.notify(p, "Tuhle kresbu zabavila stráž.", "warning");
  rememberTransient(rec);
  sendTo(p, EV.prohlizet, { ...viewMsg(rec, p), inv: true });
}

// ---------------------------------------------------------------------------
// vývěska: věšení, strhávání, nabídka

export function slotRec(r: DrawingRec): SlotRec {
  return { d: r.id, h: r.h, t: r.t, a: r.s ? r.a : "", u: r.u, p: r.p };
}

/** bake = false: textura se zatím nepeče (klienti kresbu kreslí čarami, SlotMsg.pend), upeče ji až api boardBake */
export function hang(b: BoardRec, slot: number, rec: DrawingRec, bake = true) {
  putDrawing(rec);
  b.slots[slot] = slotRec(rec);
  changed(b);
  if (bake) void assets.want(rec.id); // textura listu ve světě (po přenačtení balíčku se list vymění)
}

async function pin(p: Player, b: BoardRec, slot: number): Promise<void> {
  const list = itemDrawings(p);
  const pick = await most.menu(p, {
    title: "Připíchnout kresbu",
    options: [...list.map((x) => ({ id: x.row, text: x.data.t + (x.data.s ? " (podepsaná)" : "") })), { id: "#zpet", text: "Zpět" }],
  });
  const it = list.find((x) => x.row === pick);
  if (!it || b.slots[slot] || liveAt(b, slot)) return;
  const rec = await recordOfItem(it.data);
  if (!rec) return void most.notify(p, "Kresba je rozmazaná, nejde připíchnout.", "warning");
  if (!most.takeRow(p, it.row, 1)) return;
  hang(b, slot, rec);
  await most.notify(p, `„${rec.t}“ visí na vývěsce.`, "success");
}

async function canTear(p: Player, s: SlotRec): Promise<boolean> {
  if (CFG.tearDown === "anyone") return true;
  if (CFG.tearDown === "author" && s.u === (await most.charId(p))) return true;
  return most.can(p, "kresby.moderate");
}

export async function tear(p: Player, b: BoardRec, slot: number): Promise<boolean> {
  const s = b.slots[slot];
  if (!s) return false;
  const rec = await getDrawing(s.d);
  b.slots[slot] = null;
  changed(b);
  if (!rec) return false;
  const embedded = rec.d.length <= CFG.itemDataMax;
  if (!giveDrawing(p, rec)) {
    b.slots[slot] = s; // nevešlo se do brašny: zpět na vývěsku
    changed(b);
    return false;
  }
  if (embedded) deleteDrawing(rec.id); // předmět ji nese celou
  return true;
}

/** EV.pouzit: hráč použil desku (zamířil na list a stiskl klávesu / nápovědu akce) */
export async function useBoard(p: Player, msg: { b?: unknown; slot?: unknown }) {
  const b = allBoards.get(Number(msg?.b));
  if (!b) return;
  if (dist(b, p.position) > CFG.useRange + Math.max(b.w, b.h) / 2) return void most.notify(p, "Jsi od desky moc daleko.");
  if (b.kind === "kram") return openShop(p);
  if (b.owner) return; // deska jiného resource (škola …): kreslí se jen přes jeho relace (server/api.ts)
  const slot = Math.floor(Number(msg?.slot));
  if (!(slot >= 0 && slot < b.slots.length)) return;
  if (sessionOfPlayer(p)) return;
  const l = liveAt(b, slot);
  if (l) return void most.notify(p, "Na tenhle list právě někdo kreslí.");
  const s = b.slots[slot];
  const moderator = await most.can(p, "kresby.moderate");
  if (s && s.hid && !moderator) return void most.notify(p, "Tenhle list zabavila stráž.");
  if (s) {
    const pick = await most.menu(p, {
      title: `„${citelne(p, s.t, s.h)}“`,
      text: s.a ? "Podepsáno: " + citelne(p, s.a, s.h + "a") : "Nepodepsáno.",
      options: [
        { id: "prohlednout", text: "Prohlédnout" },
        { id: "strhnout", text: "Strhnout list a vzít si ho", enabled: await canTear(p, s) },
        ...(moderator ? [{ id: s.hid ? "obnovit" : "skryt", text: s.hid ? "Vrátit zabavenou kresbu" : "Zabavit kresbu (moderace)" }] : []),
        { id: "#zavrit", text: "Odejít" },
      ],
    });
    if (pick === "prohlednout") {
      const rec = await getDrawing(s.d);
      // na desce: kamera na list (textura ve světě); bez textury klient ukáže kresbu přes list
      if (rec) sendTo(p, EV.prohlizet, { ...viewMsg(rec, p), board: b.id, slot, o: assets.shardOf(rec.id), id: rec.id } as ViewMsg);
    } else if (pick === "strhnout" && b.slots[slot] === s && (await canTear(p, s))) {
      if (await tear(p, b, slot)) await most.notify(p, `Strhl jsi „${s.t}“.`);
    } else if ((pick === "skryt" || pick === "obnovit") && moderator) {
      await moderate(b, slot, pick === "skryt");
    }
    return;
  }
  const have = sheetsOf(p);
  const total = have.reduce((a, x) => a + (x ?? 0), 0);
  const own = itemDrawings(p).length;
  const pick = await most.menu(p, {
    title: b.kind === "stojan" ? "Stojan" : "Vývěska",
    text: total ? "Čistý list je připravený." : "Na kreslení potřebuješ čistý list (pergamen, papír …, prodává je písař).",
    options: [
      ...CFG.papiry.map((x) => ({ id: "kreslit" + x.kod, text: `Kreslit: ${x.name} (${have[x.kod] ?? 0})`, enabled: (have[x.kod] ?? 0) > 0 })),
      { id: "pripichnout", text: "Připíchnout kresbu z brašny", enabled: own > 0 },
      { id: "#zavrit", text: "Odejít" },
    ],
  });
  if (pick?.startsWith("kreslit")) await startSession(p, b, slot, Number(pick.slice(7)) || 0);
  else if (pick === "pripichnout") await pin(p, b, slot);
}

// ---------------------------------------------------------------------------
// moderace (příkazy i panel ve správě)

export async function moderate(b: BoardRec, slot: number, hide: boolean): Promise<boolean> {
  const s = b.slots[slot];
  if (!s) return false;
  s.hid = hide || undefined;
  const rec = await getDrawing(s.d);
  if (rec) {
    rec.hid = hide || undefined;
    putDrawing(rec);
  }
  changed(b);
  return true;
}

export function findSlot(drawingId: number): { b: BoardRec; slot: number } | null {
  for (const b of allBoards.values()) {
    const i = b.slots.findIndex((s) => s?.d === drawingId);
    if (i >= 0) return { b, slot: i };
  }
  return null;
}

export async function setHidden(drawingId: number, hide: boolean): Promise<boolean> {
  const at = findSlot(drawingId);
  if (at) return moderate(at.b, at.slot, hide);
  const rec = await getDrawing(drawingId);
  if (!rec) return false;
  rec.hid = hide || undefined;
  putDrawing(rec);
  return true;
}

export async function remove(drawingId: number): Promise<boolean> {
  const at = findSlot(drawingId);
  if (at) {
    at.b.slots[at.slot] = null;
    changed(at.b);
  }
  const rec = await getDrawing(drawingId);
  deleteDrawing(drawingId);
  assets.forget(drawingId);
  return !!(at || rec);
}

// ---------------------------------------------------------------------------
// obsah kreseb klientům: EV.chci { h: [...] } -> EV.data po jedné, s limitem B/s na hráče

const buckets = new Map<number, { tokens: number; at: number }>();

export async function serveData(p: Player, msg: { h?: unknown }) {
  const list = Array.isArray(msg?.h) ? msg.h.filter((x): x is string => typeof x === "string" && /^[0-9a-f]{16}$/.test(x)).slice(0, LIMITS.dataBatch) : [];
  if (!list.length) return;
  const t = Date.now();
  const b = buckets.get(p.id) ?? { tokens: CFG.dataRate, at: t };
  b.tokens = Math.min(CFG.dataRate * 2, b.tokens + ((t - b.at) / 1000) * CFG.dataRate);
  b.at = t;
  buckets.set(p.id, b);
  for (const h of list) {
    if (b.tokens <= 0) {
      sendTo(p, EV.data, { h, d: null, retry: true } as DataMsg);
      continue;
    }
    const rec = await getByHash(h);
    const d = rec && !rec.hid ? rec.d : null;
    b.tokens -= (d?.length ?? 0) + 64;
    sendTo(p, EV.data, { h, d } as DataMsg);
  }
}

export function forgetPlayer(p: Player) {
  buckets.delete(p.id);
}

/** popis kreseb na desce pro správu */
export function describe(b: BoardRec) {
  const list = slots(faceOf(b));
  return b.slots.map((s, i) => ({ slot: i, s, at: list[i] }));
}

