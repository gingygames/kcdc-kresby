// Živé kreslení: relace hráče u listu na desce. Server je jediný zdroj pravdy:
// * klient posílá dávky tahů (k3, pořadové číslo), server každý tah ověří (nástroj, inkoust, rozsahy, limity,
//   spotřeba kapek / uhlu) a potvrdí (EV.ack); odmítnutý tah zahodí a klient srovná stav;
// * neplatný vstup (rozbitá data, díra v pořadí, cizí relace, záplava zpráv) relaci ukončí;
// * přijaté tahy jdou po ~150 ms divákům do CFG.liveRange (EV.zive); kdo přijde později, dostane vše najednou;
// * dokončení: dialog nechat viset / vzít s sebou, s podpisem nebo bez; materiál se odebere až teď a najednou.

import { MAX_INKS, TOOL, decode, encodeK3, type Drawing, type Ink, type Stroke } from "../shared/codec";
import { strokeUse } from "../shared/ink";
import { slots, viewPoint } from "../shared/layout";
import { EV, type AckMsg, type CanvasMsg, type LockedInk, type LiveMsg, type StrokesMsg } from "../shared/protocol";
import * as assets from "./assets";
import { dist, faceOf, liveAt, sendTo, setLive, viewers } from "./boards";
import { CFG } from "./config";
import { cleanTitle, giveDrawing, hang, makeRecord } from "./drawings";
import { consume, convertNative, inksOf, needsText, sheetsOf, toolsOf, type InkRow } from "./materials";
import * as most from "./most";
import { boards, deleteDrawing, type BoardRec, type DrawingRec } from "./store";

interface Session {
  id: number;
  p: Player;
  cid: string;
  b: BoardRec;
  slot: number;
  paper: number;
  inks: InkRow[];
  used: number[]; // kapky po inkoustech (desetinné)
  charcoalAvail: number; // px²
  charcoalUsed: number;
  tools: Set<number>;
  strokes: Stroke[];
  uses: { a: number; b: number; c: number }[];
  points: number;
  seq: number;
  last: number;
  title: string;
  sentTo: Set<number>; // diváci, kteří už mají celý stav
  pending: Stroke[];
  undo: number;
  finishing: boolean;
  window: { at: number; n: number }; // záplava dávek
  free?: FreeOpts; // relace jiného resource (server/api.ts): bez materiálu, bez dialogu dokončení
  base: number; // tahů předlohy (zamčené, zpět je nevezme)
}

/** volná relace pro jiný resource (škola: tabule, písanka): materiál neplatí, hotovo bez dialogu */
export interface FreeOpts {
  owner: string;
  inks: (Ink & { name?: string; pick?: boolean })[]; // inkousty relace (index od 1 v tazích předlohy); pick:false = jen předloha
  tools: number[];
  base: Stroke[]; // předloha / dosavadní obsah listu: hráč na ni kreslí dál, zpět ji nevezme
  title: string;
  hang: boolean; // hotová kresba nahradí list na desce (textura ve světě); jinak jen výsledek
  bake?: boolean; // false = textura se zatím nepeče (klienti ji kreslí čarami), upeče ji až api boardBake
  done?: (r: FreeResult) => void;
  reported?: boolean;
}

export interface FreeResult {
  ok: boolean;
  player: number;
  board: number;
  slot: number;
  why?: string;
  id?: number; // kresba
  d?: string; // "k3." celé tahy (předloha + nové)
  added?: number; // nových tahů
}

const sessions = new Map<number, Session>();
const byPlayer = new Map<number, Session>();
const cooldown = new Map<string, number>();
let lastId = 0;

const log = (t: string) => console.log("[kresby] " + t);

export const sessionOfPlayer = (p: Player) => byPlayer.get(p.id) ?? null;
export const activeSessions = () => sessions.size;

/** recepty, jejichž inkoust hráč nemá: na plátně zamčené, s radou, kde je sehnat */
function lockedInks(have: string[]): LockedInk[] {
  const own = new Set(have.map((n) => n.toLowerCase()));
  return CFG.recipes
    .filter((r) => !own.has(r.name.toLowerCase()))
    .slice(0, 16)
    .map((r) => {
      const sold = CFG.shop.find((x) => x.kind === "ink" && x.recipe === r.id);
      const where = sold ? `${CFG.pisar || "Písař"} ho prodává za ${sold.price} gr.` : r.needs.length ? `Namíchej z: ${needsText(r)} a prázdné lahvičky.` : "Zatím ho nikdo neprodává.";
      return { name: r.name, rgb: r.rgb, flags: r.flags, where };
    });
}

function canvasMsg(s: Session, resume = false): CanvasMsg {
  const f = faceOf(s.b);
  const sl = slots(f)[s.slot];
  return {
    s: s.id,
    b: s.b.id,
    slot: s.slot,
    paper: s.paper,
    tools: [...s.tools],
    inks: s.inks.map((i, k) => ({
      name: i.name, rgb: i.ink.rgb, flags: i.ink.flags, strength: i.ink.strength, drops: Math.max(0, i.drops - s.used[k]),
      ...(s.free && s.free.inks[k]?.pick === false ? { pick: false as const } : {}),
    })),
    locked: s.free ? [] : lockedInks(s.inks.map((i) => i.name)),
    ...(s.free ? { unlimited: true as const } : {}),
    charcoal: Math.max(0, s.charcoalAvail - s.charcoalUsed),
    limits: { points: CFG.maxPoints - s.points, strokes: CFG.maxStrokes - s.strokes.length, dropArea: CFG.materials.dropArea, charcoalArea: CFG.materials.charcoalArea, batch: CFG.batchStrokes, batchPoints: CFG.batchPoints, sizeMin: Math.round(CFG.velikost.min * 4), sizeMax: Math.round(CFG.velikost.max * 4) },
    title: s.title,
    resume: resume && s.strokes.length ? encodeK3({ paper: s.paper, inks: [], strokes: s.strokes }) : undefined,
    seq: s.seq,
    sheet: { pos: f.pos, n: f.n, w: f.w, h: f.h, cx: sl.cx, cy: sl.cy, sw: sl.w, sh: sl.h },
  };
}

export async function start(p: Player, b: BoardRec, slot: number, paper: number): Promise<boolean> {
  if (byPlayer.has(p.id)) return false;
  if (b.slots[slot] || liveAt(b, slot)) return void most.notify(p, "List už je pokreslený."), false;
  if (dist(b, p.position) > CFG.useRange + Math.max(b.w, b.h) / 2) return void most.notify(p, "Jsi od desky moc daleko."), false;
  if (sheetsOf(p)[paper] < 1) return void most.notify(p, "Nemáš čistý list.", "warning"), false;
  await convertNative(p);
  const { tools, charcoal } = await toolsOf(p);
  const inks = inksOf(p).slice(0, CFG.maxInks);
  if (!tools.some((t) => t !== TOOL.scrape)) return void most.notify(p, "Nemáš čím kreslit: husí brk, štětce nebo uhel.", "warning"), false;
  if (!inks.length && !tools.includes(TOOL.charcoal)) return void most.notify(p, "Nemáš inkoust ani uhel.", "warning"), false;
  if (byPlayer.has(p.id) || b.slots[slot] || liveAt(b, slot)) return false; // mezitím (await)
  const s: Session = {
    id: ++lastId,
    p,
    cid: await most.charId(p),
    b,
    slot,
    paper,
    inks,
    used: inks.map(() => 0),
    charcoalAvail: charcoal * CFG.materials.charcoalArea,
    charcoalUsed: 0,
    tools: new Set(tools),
    strokes: [],
    uses: [],
    points: 0,
    seq: 0,
    last: Date.now(),
    title: "Kresba",
    sentTo: new Set(),
    pending: [],
    undo: 0,
    finishing: false,
    window: { at: Date.now(), n: 0 },
    base: 0,
  };
  sessions.set(s.id, s);
  byPlayer.set(p.id, s);
  setLive(b, slot, s.id);
  sendTo(p, EV.platno, canvasMsg(s));
  return true;
}

/** volná relace (server/api.ts): list smí být pokreslený (kreslí se dál na předlohu), materiál se nekontroluje */
export async function startFree(p: Player, b: BoardRec, slot: number, paper: number, opts: FreeOpts): Promise<boolean | string> {
  if (byPlayer.has(p.id)) return "Hráč už kreslí.";
  if (liveAt(b, slot)) return "Na list právě kreslí někdo jiný.";
  if (!(slot >= 0 && slot < b.slots.length)) return "List na desce není.";
  const inks: InkRow[] = opts.inks.slice(0, CFG.maxInks).map((x, i) => ({
    row: "",
    name: String(x.name ?? "Inkoust " + (i + 1)).slice(0, 40),
    ink: { rgb: x.rgb, flags: x.flags, strength: x.strength },
    drops: x.pick === false ? 0 : 1e9, // inkoustem předlohy psát nejde (server tah odmítne)
    max: 1e9,
  }));
  const base = opts.base.filter((x) => x.tool === TOOL.charcoal || x.tool === TOOL.scrape || (x.a >= 1 && x.a <= inks.length));
  const s: Session = {
    id: ++lastId,
    p,
    cid: await most.charId(p),
    b,
    slot,
    paper,
    inks,
    used: inks.map(() => 0),
    charcoalAvail: 1e12,
    charcoalUsed: 0,
    tools: new Set(opts.tools.length ? opts.tools : [TOOL.pen]),
    strokes: [...base],
    uses: base.map(() => ({ a: 0, b: 0, c: 0 })),
    points: base.reduce((n, x) => n + x.p.length / 3, 0),
    seq: 0,
    last: Date.now(),
    title: cleanTitle(opts.title),
    sentTo: new Set(),
    pending: [],
    undo: 0,
    finishing: false,
    window: { at: Date.now(), n: 0 },
    free: opts,
    base: base.length,
  };
  if (byPlayer.has(p.id) || liveAt(b, slot)) return "Hráč už kreslí."; // mezitím (await)
  sessions.set(s.id, s);
  byPlayer.set(p.id, s);
  setLive(b, slot, s.id);
  sendTo(p, EV.platno, canvasMsg(s, true));
  return true;
}

function report(s: Session, r: Omit<FreeResult, "player" | "board" | "slot">) {
  const f = s.free;
  if (!f || f.reported) return;
  f.reported = true;
  const full: FreeResult = { player: s.p.id, board: s.b.id, slot: s.slot, ...r };
  try {
    f.done?.(full);
  } catch (e) {
    log(`${f.owner}: hotovo: ${String(e)}`);
  }
  try {
    if (typeof (Events as any).emit === "function") void Promise.resolve((Events as any).emit("kresby:hotovo", f.owner, full)).catch(() => undefined);
  } catch {
    // jen událost navíc
  }
}

export function end(s: Session, why: string, tell = true) {
  if (!sessions.delete(s.id)) return;
  report(s, { ok: false, why });
  byPlayer.delete(s.p.id);
  setLive(s.b, s.slot, null);
  const bye: LiveMsg = { b: s.b.id, slot: s.slot, s: s.id, end: true };
  for (const id of s.sentTo) {
    const v = Player.getById(id);
    if (v) sendTo(v, EV.zive, bye);
  }
  if (tell) sendTo(s.p, EV.zavrit, { s: s.id, why });
}

function own(p: Player, msg: { s?: unknown }): Session | null {
  const s = sessions.get(Number(msg?.s));
  return s && s.p.id === p.id ? s : null;
}

/** ověří tah; vrátí spotřebu, nebo null (odmítnout) */
function check(s: Session, t: Stroke): { a: number; b: number; c: number } | null {
  if (!s.tools.has(t.tool)) return null;
  if (t.size < Math.max(2, Math.round(CFG.velikost.min * 4)) || t.size > Math.min(160, Math.round(CFG.velikost.max * 4)) || t.op < 13 || t.op > 255 || t.mix > 255) return null;
  const inked = t.tool === TOOL.pen || t.tool === TOOL.brush;
  if (inked && (t.a < 1 || t.a > s.inks.length || t.b > s.inks.length || t.b === t.a)) return null;
  if (inked && s.free && (s.free.inks[t.a - 1]?.pick === false || (t.b && s.free.inks[t.b - 1]?.pick === false))) return null; // inkoust předlohy
  if (!inked && (t.a !== 0 || t.b !== 0)) return null;
  const n = t.p.length / 3;
  if (n < 1 || s.points + n > CFG.maxPoints || s.strokes.length >= CFG.maxStrokes) return null;
  for (let i = 0; i < t.p.length; i += 3) {
    if (t.p[i] < 0 || t.p[i] > 767 || t.p[i + 1] < 0 || t.p[i + 1] > 511) return null;
  }
  const inks = s.inks.map((i) => i.ink);
  const u = strokeUse(t, inks, CFG.materials.dropArea);
  if (inked) {
    // nejvýš o 1 kapku přes (zaokrouhlení: klient počítá stejný vzorec, poslední tah smí dojet)
    if (s.used[t.a - 1] + u.a > s.inks[t.a - 1].drops + 0.999) return null;
    if (t.b && s.used[t.b - 1] + u.b > s.inks[t.b - 1].drops + 0.999) return null;
  }
  if (t.tool === TOOL.charcoal && s.charcoalUsed + u.charcoal > s.charcoalAvail + CFG.materials.charcoalArea * 0.02) return null;
  return { a: u.a, b: u.b, c: u.charcoal };
}

export function onStrokes(p: Player, raw: unknown) {
  const msg = raw as StrokesMsg;
  const s = own(p, msg);
  if (!s || s.finishing) return;
  const t = Date.now();
  if (t - s.window.at > 1000) s.window = { at: t, n: 0 };
  if (++s.window.n > 40) return end(s, "Moc rychlé zprávy, kreslení skončilo.");
  const seq = Math.floor(Number(msg.seq));
  if (seq <= s.seq) return; // opakovaná dávka
  if (seq !== s.seq + 1) return end(s, "Ztratily se tahy, kreslení skončilo.");
  const d: Drawing | null = decode(msg.d, MAX_INKS); // neznámý inkoust odmítne check() po tazích
  if (!d || d.inks.length || d.strokes.length > CFG.batchStrokes) return end(s, "Neplatná data, kreslení skončilo.");
  let pts = 0;
  for (const x of d.strokes) pts += x.p.length / 3;
  if (pts > CFG.batchPoints) return end(s, "Neplatná data, kreslení skončilo.");
  s.seq = seq;
  s.last = t;
  const rej: number[] = [];
  let ok = 0;
  d.strokes.forEach((x, i) => {
    const u = check(s, x);
    if (!u) return void rej.push(i);
    s.strokes.push(x);
    s.uses.push(u);
    s.points += x.p.length / 3;
    if (x.a) s.used[x.a - 1] += u.a;
    if (x.b) s.used[x.b - 1] += u.b;
    s.charcoalUsed += u.c;
    s.pending.push(x);
    ok++;
  });
  ack(s, seq, ok, rej);
}

function ack(s: Session, seq: number, ok: number, rej: number[], why?: string) {
  const m: AckMsg = {
    s: s.id,
    seq,
    ok,
    rej,
    drops: s.inks.map((i, k) => Math.max(0, Math.round((i.drops - s.used[k]) * 100) / 100)),
    charcoal: Math.max(0, s.charcoalAvail - s.charcoalUsed),
    why,
  };
  sendTo(s.p, EV.ack, m);
}

export function onUndo(p: Player, raw: unknown) {
  const s = own(p, raw as { s?: unknown });
  if (!s || s.finishing) return;
  const want = Math.max(0, Math.floor(Number((raw as { n?: unknown })?.n) || 1));
  const n = Math.min(s.strokes.length - s.base, want);
  for (let i = 0; i < n; i++) {
    const x = s.strokes.pop()!;
    const u = s.uses.pop()!;
    s.points -= x.p.length / 3;
    if (x.a) s.used[x.a - 1] -= u.a;
    if (x.b) s.used[x.b - 1] -= u.b;
    s.charcoalUsed -= u.c;
    if (s.pending.length) s.pending.pop();
    else s.undo++;
  }
  s.last = Date.now();
  ack(s, s.seq, 0, []);
  if (s.free && want > n) resume(s); // volná relace: klient vzal zpět i předlohu, vrátit mu ji
}

export function onCancel(p: Player, raw: unknown) {
  const s = own(p, raw as { s?: unknown });
  if (s) end(s, "Přestal jsi kreslit. List zůstal čistý.");
}

export async function onFinish(p: Player, raw: unknown) {
  const s = own(p, raw as { s?: unknown });
  if (!s || s.finishing) return;
  if (s.free) return finishFree(s, raw);
  s.title = cleanTitle((raw as { title?: unknown })?.title);
  const bad = CFG.moderace.zakazanaSlova.find((w) => s.title.toLowerCase().includes(w.toLowerCase()));
  if (bad) {
    await most.notify(p, `Takový název kresba mít nesmí („${bad}“).`, "warning");
    return resume(s);
  }
  if (!s.strokes.length) return end(s, "List zůstal čistý.");
  const until = cooldown.get(s.cid) ?? 0;
  if (until > Date.now()) {
    await most.notify(p, `Další kresbu můžeš uložit za ${Math.ceil((until - Date.now()) / 1000)} s.`, "warning");
    return resume(s);
  }
  s.finishing = true;
  const pick = await most.menu(p, {
    title: `„${s.title}“`,
    text: "Co s kresbou?",
    options: [
      { id: "viset1", text: "Nechat viset (podepsat)" },
      { id: "viset0", text: "Nechat viset bez podpisu" },
      { id: "vzit1", text: "Vzít s sebou (podepsat)" },
      { id: "vzit0", text: "Vzít s sebou bez podpisu" },
      { id: "dal", text: "Kreslit dál" },
    ],
  });
  if (!sessions.has(s.id)) return;
  if (!pick || pick === "dal") {
    s.finishing = false;
    return resume(s);
  }
  if (pick.startsWith("viset") && CFG.moderace.maxVystavenych > 0) {
    let mine = 0;
    for (const bb of boards.values()) for (const x of bb.slots) if (x && x.u === s.cid) mine++;
    if (mine >= CFG.moderace.maxVystavenych) {
      s.finishing = false;
      await most.notify(p, `Vystavených kreseb máš už ${mine}, víc nejde. Vezmi ji s sebou, nebo strhni jinou.`, "warning");
      return resume(s);
    }
  }
  const signed = pick.endsWith("1");
  const use = new Map<string, number>();
  s.inks.forEach((i, k) => use.set(i.row, (use.get(i.row) ?? 0) + s.used[k]));
  const charcoal = s.charcoalUsed > 0 ? Math.ceil(s.charcoalUsed / CFG.materials.charcoalArea - 1e-9) : 0;
  const why = await consume(p, use, s.paper, charcoal);
  if (!sessions.has(s.id)) return;
  if (why) {
    s.finishing = false;
    await most.notify(p, why + " Kresba se neuložila.", "error");
    return resume(s);
  }
  const rec = await makeRecord(p, { paper: s.paper, inks: s.inks.map((i) => i.ink), strokes: s.strokes }, s.title, signed);
  cooldown.set(s.cid, Date.now() + CFG.cooldownMs);
  const b = s.b;
  const slot = s.slot;
  end(s, "Kresba je hotová.");
  if (pick.startsWith("viset")) {
    hang(b, slot, rec);
    await most.notify(p, `„${rec.t}“ visí na ${b.kind === "stojan" ? "stojanu" : "vývěsce"}.`, "success");
  } else {
    if (!giveDrawing(p, rec)) {
      hang(b, slot, rec); // do brašny se nevešla: zůstane viset
      await most.notify(p, "Do brašny se kresba nevešla, nechal jsi ji viset.", "warning");
    } else await most.notify(p, `„${rec.t}“ máš v brašně.`, "success");
  }
  log(`kresba ${rec.id} „${rec.t}“ (${rec.n} bodů, ${rec.d.length} B) od ${p.nickname}`);
}

async function finishFree(s: Session, raw: unknown) {
  const f = s.free!;
  s.finishing = true;
  const t = (raw as { title?: unknown })?.title;
  if (typeof t === "string" && t.trim()) s.title = cleanTitle(t);
  const added = s.strokes.length - s.base;
  const rec: DrawingRec = await makeRecord(s.p, { paper: s.paper, inks: s.inks.map((i) => i.ink), strokes: s.strokes }, s.title, true);
  if (!sessions.has(s.id)) return;
  const b = s.b;
  const slot = s.slot;
  report(s, { ok: true, id: rec.id, d: rec.d, added });
  end(s, "Hotovo.");
  if (f.hang) replaceSlot(b, slot, rec, f.bake !== false);
  log(`${f.owner}: kresba ${rec.id} (${rec.n} bodů, +${added} tahů) od ${s.p.nickname}`);
}

/** list desky nahradit kresbou; stará kresba desky jiného resource se smaže i s texturou (sdílená zůstane) */
export function replaceSlot(b: BoardRec, slot: number, rec: DrawingRec, bake = true) {
  const old = b.slots[slot];
  hang(b, slot, rec, bake);
  if (rec.k) b.slots[slot]!.k = 1;
  if (old && b.owner && old.d !== rec.id && !old.k) dropDrawing(old.d);
}

/** kresba pryč natrvalo: záznam i textura (balíček se přenačte s dalším) */
export function dropDrawing(id: number) {
  deleteDrawing(id);
  assets.forget(id);
}

function resume(s: Session) {
  sendTo(s.p, EV.platno, canvasMsg(s, true));
}

/** klient plátno otevřít neumí (žádná cesta UI): relace končí */
export function onCanvasError(p: Player, raw: unknown) {
  const s = own(p, raw as { s?: unknown });
  if (s) {
    log(`klient ${p.nickname} neotevřel plátno: ${String((raw as { why?: unknown })?.why)}`);
    end(s, "Kreslení se nepodařilo otevřít.");
  }
}

// ---------------------------------------------------------------------------
// diváci a hlídání

export function flushLive() {
  for (const s of sessions.values()) {
    const vs = viewers(s.b, s.p.id);
    const encInks = s.inks.map((i) => i.ink);
    for (const v of vs) {
      if (!s.sentTo.has(v.id)) {
        s.sentTo.add(v.id);
        const m: LiveMsg = { b: s.b.id, slot: s.slot, s: s.id, paper: s.paper, inks: encInks };
        if (s.strokes.length) m.add = encodeK3({ paper: s.paper, inks: [], strokes: s.strokes });
        sendTo(v, EV.zive, m);
      } else if (s.pending.length || s.undo) {
        const m: LiveMsg = { b: s.b.id, slot: s.slot, s: s.id };
        if (s.undo) m.undo = s.undo;
        if (s.pending.length) m.add = encodeK3({ paper: s.paper, inks: [], strokes: s.pending });
        sendTo(v, EV.zive, m);
      }
    }
    // kdo odešel z dosahu, dostane konec a při návratu celý stav znovu
    const here = new Set(vs.map((v) => v.id));
    for (const id of s.sentTo) {
      if (here.has(id)) continue;
      s.sentTo.delete(id);
      const v = Player.getById(id);
      if (v) sendTo(v, EV.zive, { b: s.b.id, slot: s.slot, s: s.id, end: true } as LiveMsg);
    }
    s.pending = [];
    s.undo = 0;
  }
}

export function watchdog() {
  const t = Date.now();
  for (const s of [...sessions.values()]) {
    if (!s.finishing && t - s.last > CFG.idleMs) end(s, "Dlouho jsi nekreslil, list zůstal čistý.");
    else if (dist(s.b, s.p.position) > CFG.useRange + 6 + Math.max(s.b.w, s.b.h)) end(s, "Odešel jsi od desky.");
  }
}

export function onDisconnect(p: Player) {
  const s = byPlayer.get(p.id);
  if (s) end(s, "", false);
  for (const x of sessions.values()) x.sentTo.delete(p.id);
}

export function endAll() {
  for (const s of [...sessions.values()]) end(s, "Kreslení skončilo (restart).");
}

/** pro /kresby info */
export function camera(s: Session, fov = 55, aspect = 16 / 9) {
  const f = faceOf(s.b);
  return viewPoint(f, slots(f)[s.slot], fov, aspect);
}
