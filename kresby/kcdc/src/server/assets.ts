// Textury kreseb jako streamované assety KCDC.
//
// KCDC neumí texturu ze skriptu za běhu, umí ale streamovat soubory z resource (`stream/`) a po restartu resource je
// klienti stáhnou a vymění "na místě" (docs: Custom assets, "A changed model, material or texture updates on screen").
// Kresby proto:
// 1. vykreslí pověšenou kresbu na serveru do rastru (server/raster.ts) a uloží jako DDS hry (server/dds.ts) spolu
//    s modelem listu a materiálem (server/cgf.ts); všechno po kouscích (`CFG.svet.rozpocetMs` na krok serveru),
// 2. soubory zapíšou do balíčků assetů = samostatných resource bez skriptů `<predpona>-<n>` ve složce resources serveru,
// 3. požádají o přenačtení balíčku (hák `svet.reload`, nebo konzole playgroundu, nebo až restart serveru),
// 4. po `resourceStart` balíčku je textura u hráčů a server postaví list jako Prop s modelem kresby (server/props.ts).
//
// Balíčky (od 1. 11. 2026): přenačtený balíček znovu stáhne každý připojený hráč. Proto:
// * nové kresby za běhu jdou do malého "horkého" balíčku (`svet.horky` kreseb, ~1 MB), přenačítá se jen ten,
// * "studené" balíčky (`svet.shard` kreseb) se za běhu nemění: smazaná kresba v nich nechá díru, nikdo je nepřenačítá,
// * při startu serveru (žádný hráč není připojený) se horké kresby přelijí do děr a nových studených balíčků
//   (přenačtení bez hráčů nic nestojí). Bez háku pro přenačtení se nepřelévá (kresby by zmizely do dalšího restartu).
// Přenačtení má generace: kresba zapsaná až po odeslání restartu balíčku čeká na další přenačtení, a když po
// restartu nepřijde `resourceStart`, zkusí se to znovu (s rostoucím odstupem).
//
// Serverové skripty KCDC mají Node (`require("fs")`, složka serveru = cwd), ověřeno na KCDC 1.7.1.

import { decode, type Drawing } from "../shared/codec";
import { LOOK } from "../shared/look";
import { sheetMaterial, sheetModel } from "./cgf";
import { CFG } from "./config";
import { writeDdsSteps, type DdsFiles } from "./dds";
import { Budget, drainPool, release, renderSheet, resampleSteps } from "./raster";
import { storage } from "./most";
import { flush, saveLater } from "./store";

declare const require: ((id: string) => any) | undefined;

const log = (t: string) => console.log("[kresby] " + t);

interface Fs {
  existsSync(p: string): boolean;
  mkdirSync(p: string, o?: object): void;
  writeFileSync(p: string, d: string | Uint8Array): void;
  readFileSync(p: string, e?: string): any;
  readdirSync(p: string): string[];
  rmSync(p: string, o?: object): void;
  renameSync(a: string, b: string): void;
  promises?: { writeFile(p: string, d: string | Uint8Array): Promise<void> };
}

let fs: Fs | null = null;
let net: any = null;
function node() {
  if (fs) return fs;
  try {
    if (typeof require === "function") {
      fs = require("node:fs");
      net = require("node:net");
    }
  } catch {
    fs = null;
  }
  return fs;
}

/** zápis souboru mimo hlavní vlákno (fs.promises), jinak synchronně */
function writeFile(p: string, d: string | Uint8Array): Promise<void> | void {
  const f = node()!;
  if (f.promises?.writeFile) return f.promises.writeFile(p, d);
  f.writeFileSync(p, d);
}

// ---------------------------------------------------------------------------
// stav

interface State {
  v: 1;
  /** id kresby -> balíček */
  of: Record<string, string>;
  /** kresby zapsané od posledního startu svého balíčku (klienti je ještě nemají) */
  pend: number[];
  /** balíčky, jejichž soubory se změnily od posledního startu balíčku */
  dirty: string[];
  /** verze prázdných listů (podpis papírů z nastavení) a jestli je klienti už mají */
  blank: string;
  blankPend: boolean;
  /** verze modelu listu (cgf, mtl): po změně se modely hotových kreseb přepíšou (textury zůstanou) */
  model?: number;
  /** horké balíčky (nové kresby za běhu); co v nich je, se při startu serveru přelije do studených */
  hot?: string[];
}

/** 2 = jednostranný materiál a rub listu (31. 10. 2026; dřív oboustranný, zezadu zrcadlová kresba) */
const VERZE_MODELU = 2;

const KEY = "kresby:obrazy";
const emptyState = (): State => ({ v: 1, of: {}, pend: [], dirty: [], blank: "", blankPend: true, hot: [] });
let st: State = emptyState();
const created = new Set<string>(); // nové složky balíčků (potřebují refresh + start)
interface Job {
  id: number;
  start: boolean; // chybějící textura při startu kreseb (smí do studeného balíčku, když nikdo není připojený)
}
const queue: Job[] = [];
const waiting = new Map<number, (ok: boolean) => void>();
let busy = false;
let current = -1; // kresba, která se právě peče
let cancelled = false; // ... a mezitím se smazala
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let watchTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let lastReload = 0;
let enabled = false;
let onLive: ((shard: string, ids: number[]) => void) | null = null;
let fetchDrawing: ((id: number) => Promise<{ d: string; p: number } | null>) | null = null;
let countPlayers: () => number = () => 0;

// generace: každý zápis do balíčku ji zvýší; přenačtení si pamatuje, kterou generaci poslalo
const gen = new Map<string, number>(); // balíček -> generace posledního zápisu
const wroteAt = new Map<number, number>(); // čekající kresba -> generace jejího balíčku po zápisu
let blankGen = 0;
const sent = new Map<string, { gen: number; at: number }>(); // balíček -> odeslané přenačtení, na které čekáme
const tries = new Map<string, number>(); // balíček -> kolikrát se přenačtení nepovedlo (odstup roste)

export const stats = { rendered: 0, renderMs: 0, bytes: 0, reloads: 0, retries: 0, moved: 0, steps: 0, maxStepMs: 0, lastError: "" };

const dirOf = (shard: string) => `${CFG.svet.slozka}/${shard}`;
export const shardName = (n: number) => `${CFG.svet.predpona}-${n}`;
export const blankShard = () => shardName(0);
export const modelPath = (shard: string, name: string) => `objects/kcdc/${shard}/${name}.cgf`;
export const texturePath = (shard: string, name: string) => `textures/kcdc/${shard}/${name}.dds`;
const GAME_SHEET = "objects/manmade/task_specific_props/read_and_write/scrolls/paper_a.cgf";
const shardNo = (s: string) => Number(s.slice(CFG.svet.predpona.length + 1));
/** kolik ms čekat na resourceStart po odeslání přenačtení, než se zkusí znovu (odstup roste s nezdary) */
const reloadWait = (shard: string) => Math.max(60000, 2 * CFG.svet.reloadMs) * 2 ** Math.min(4, tries.get(shard) ?? 0);

export const isEnabled = () => enabled;

function save() {
  saveLater(KEY, st);
}

const genOf = (shard: string) => gen.get(shard) ?? 0;
/** zápis do balíčku: nová generace, balíček je rozepsaný a přenačte se */
function bump(shard: string): number {
  const g = genOf(shard) + 1;
  gen.set(shard, g);
  markDirty(shard);
  return g;
}

/** umí server balíček přenačíst za běhu? (hák, nebo konzole playgroundu) */
export function canReload(): boolean {
  if (CFG.svet.reload) return true;
  return CFG.svet.konzole && !!node()?.existsSync("logs/playground.pid");
}

const hotSize = () => Math.max(1, Math.min(Math.max(1, CFG.svet.shard), Math.round(CFG.svet.horky || 3)));

export async function init(cb: { onLive: (shard: string, ids: number[]) => void; drawing: (id: number) => Promise<{ d: string; p: number } | null>; players?: () => number }) {
  onLive = cb.onLive;
  fetchDrawing = cb.drawing;
  if (cb.players) countPlayers = cb.players;
  enabled = CFG.svet.rezim !== "cary" && !!node();
  if (!enabled) {
    if (CFG.svet.rezim !== "cary") log("textury kreseb nejdou: serverový skript nemá fs (require). Kresby ve světě jsou jen ladicí čáry.");
    return;
  }
  const saved = (await storage.get(KEY)) as State | undefined;
  if (saved && saved.v === 1)
    st = { v: 1, of: saved.of ?? {}, pend: saved.pend ?? [], dirty: saved.dirty ?? [], blank: saved.blank ?? "", blankPend: saved.blankPend ?? true, model: saved.model ?? 1, hot: saved.hot ?? [] };
  // co je na disku a není rozepsané, to klienti mají (server balíčky zabalil při startu); rozepsané se přenačte
  const disk = new Set(shardsOnDisk());
  for (const [id, shard] of Object.entries(st.of)) if (!disk.has(shard)) delete st.of[id];
  st.hot = (st.hot ?? []).filter((s) => disk.has(s));
  st.pend = st.pend.filter((id) => st.of[id]);
  for (const s of st.dirty) gen.set(s, 1);
  for (const id of st.pend) wroteAt.set(id, genOf(st.of[id]));
  if (st.blankPend) blankGen = genOf(blankShard());
  await ensureBlanks();
  aktualizovatModely();
  if (canReload() && countPlayers() === 0) await compact();
  if (st.dirty.length) scheduleReload();
}

/** modely a materiály hotových kreseb na aktuální verzi (levné: jen cgf, cgfm a mtl, textura se nepřekresluje) */
function aktualizovatModely() {
  if ((st.model ?? 1) >= VERZE_MODELU) return;
  const f = node()!;
  let n = 0;
  for (const shard of shardsOnDisk()) {
    const dir = `${dirOf(shard)}/stream/objects/kcdc/${shard}`;
    let soubory: string[] = [];
    try {
      soubory = f.readdirSync(dir).filter((x) => x.endsWith(".cgf"));
    } catch {
      continue;
    }
    for (const x of soubory) {
      writeModel(shard, x.slice(0, -4), true);
      n++;
    }
    if (soubory.length) bump(shard); // model se vymění na místě, kresby nečekají (pend se nemění)
  }
  st.model = VERZE_MODELU;
  save();
  if (n) log(`modely listů: ${n} přepsáno na verzi ${VERZE_MODELU} (jednostranný list s rubem)`);
}

function shardsOnDisk(): string[] {
  const f = node();
  if (!f || !f.existsSync(CFG.svet.slozka)) return [];
  return f
    .readdirSync(CFG.svet.slozka)
    .filter((n) => n.startsWith(CFG.svet.predpona + "-") && Number.isInteger(shardNo(n)) && f.existsSync(`${dirOf(n)}/package.json`))
    .sort((a, b) => shardNo(a) - shardNo(b));
}

function ensureShard(shard: string) {
  const f = node()!;
  const dir = dirOf(shard);
  if (f.existsSync(`${dir}/package.json`)) return;
  f.mkdirSync(`${dir}/stream/objects/kcdc/${shard}`, { recursive: true });
  f.mkdirSync(`${dir}/stream/textures/kcdc/${shard}`, { recursive: true });
  f.writeFileSync(
    `${dir}/package.json`,
    JSON.stringify({ name: shard, version: "1.0.0", description: "Textury kreseb (resource kresby, generuje se samo; nemazat ručně)", mafiahub: {} }, null, 2) + "\n",
  );
  created.add(shard);
  log(`nový balíček textur ${shard}`);
}

function markDirty(shard: string) {
  if (!st.dirty.includes(shard)) st.dirty.push(shard);
  save();
  scheduleReload();
}

/** model listu: kresba (když ji klienti mají), jinak prázdný list papíru, jinak list hry */
export function modelFor(drawingId: number | null, paper: number): { model: string; shard: string | null } {
  if (enabled && drawingId !== null) {
    const shard = st.of[drawingId];
    if (shard && !st.pend.includes(drawingId)) return { model: modelPath(shard, "k" + drawingId), shard };
  }
  if (enabled && !st.blankPend) {
    const kod = LOOK.papers.some((p) => p.kod === paper) ? paper : (LOOK.papers[0]?.kod ?? 0);
    // kresba, jejíž textura se teprve vykresluje / přenačítá: čistý list, klienti přes něj kreslí tahy čarami
    // (SlotMsg.pend); „načítá se“ ukazuje jen prohlížeč
    return { model: modelPath(blankShard(), "list" + kod), shard: null };
  }
  return { model: GAME_SHEET, shard: null };
}

export const isGameSheet = (model: string) => model === GAME_SHEET;
export const shardOf = (drawingId: number) => (st.of[drawingId] && !st.pend.includes(drawingId) ? st.of[drawingId] : undefined);

/** pro /kresby info */
export function summary(): string {
  if (!enabled) return "balíčky textur: vypnuté";
  const c = counts();
  const hot = st.hot ?? [];
  const cold = shardsOnDisk().filter((s) => s !== blankShard() && !hot.includes(s));
  const inHot = hot.reduce((n, s) => n + (c.get(s) ?? 0), 0);
  return (
    `balíčky textur: ${cold.length} studených, ${hot.length} horkých (${inHot} kreseb, po ${canReload() ? hotSize() : CFG.svet.shard}), ` +
    `čeká ${st.pend.length}, rozepsané ${st.dirty.join(", ") || "žádné"}, nejdelší krok pečení ${stats.maxStepMs} ms`
  );
}

// ---------------------------------------------------------------------------
// vykreslení

const texW = () => Math.max(64, Math.min(4096, 2 ** Math.round(Math.log2(CFG.svet.sirka || 1024))));

/** rastr -> převzorkování -> mipmapy -> BC1, všechno po kouscích (generátor) */
export function* bakeSteps(d: Drawing, k: number): Generator<void, DdsFiles> {
  const cv = yield* renderSheet(d, k, 4000);
  const w = texW();
  const b = new Budget(4000);
  const tex = yield* resampleSteps(cv, w, w / 2, b);
  release(cv.px);
  const dds = yield* writeDdsSteps(tex, 4, b);
  release(tex.px);
  return dds;
}

/** generátor po kouscích: nejvýš CFG.svet.rozpocetMs práce, pak vrátit tick serveru */
async function drive<T>(g: Generator<void, T>): Promise<T> {
  let r = g.next();
  let t = Date.now();
  while (!r.done) {
    const dt = Date.now() - t;
    if (dt >= CFG.svet.rozpocetMs) {
      stats.steps++;
      if (dt > stats.maxStepMs) stats.maxStepMs = dt;
      await new Promise((x) => setTimeout(x, 0));
      t = Date.now();
    }
    r = g.next();
  }
  return r.value;
}

function writeModel(shard: string, name: string, sync = false): Promise<unknown> {
  const { cgf, cgfm } = sheetModel(`objects/kcdc/${shard}/${name}`);
  const base = `${dirOf(shard)}/stream/objects/kcdc/${shard}/${name}`;
  const mtl = sheetMaterial(texturePath(shard, name), { shininess: CFG.svet.lesk });
  stats.bytes += cgf.length + cgfm.length;
  if (sync) {
    const f = node()!;
    f.writeFileSync(base + ".cgf", cgf);
    f.writeFileSync(base + ".cgfm", cgfm);
    f.writeFileSync(base + ".mtl", mtl);
    return Promise.resolve();
  }
  return Promise.all([writeFile(base + ".cgf", cgf), writeFile(base + ".cgfm", cgfm), writeFile(base + ".mtl", mtl)]);
}

async function writeSheet(shard: string, name: string, dds: DdsFiles) {
  const dir = dirOf(shard);
  const w: (Promise<unknown> | void)[] = [];
  for (const [ext, bytes] of dds.files) w.push(writeFile(`${dir}/stream/textures/kcdc/${shard}/${name}.dds${ext ? "." + ext : ""}`, bytes));
  w.push(writeModel(shard, name));
  stats.bytes += dds.bytes;
  await Promise.all(w);
}

let blankRun = 0;
/** prázdné listy pro všechny druhy papíru (balíček 0); znovu, když se v nastavení změní papíry */
export async function ensureBlanks(): Promise<void> {
  if (!enabled) return;
  const sig = JSON.stringify(["list3", LOOK.papers.map((p) => [p.kod, p.rgb, p.styl]), CFG.svet.sirka, CFG.svet.lesk]);
  const shard = blankShard();
  if (st.blank === sig && node()!.existsSync(`${dirOf(shard)}/package.json`)) return;
  const run = ++blankRun;
  ensureShard(shard);
  for (const p of LOOK.papers) {
    const dds = await drive(bakeSteps({ paper: p.kod, inks: [], strokes: [] }, Math.max(0.5, CFG.svet.sirka / 768 / 2)));
    if (run !== blankRun) return; // mezitím se nastavení změnilo znovu: dokončí novější běh
    await writeSheet(shard, "list" + p.kod, dds);
  }
  // listy s přesýpacími hodinami (do 30. 10.) už se nepoužívají
  const f = node()!;
  for (const d of [`${dirOf(shard)}/stream/objects/kcdc/${shard}`, `${dirOf(shard)}/stream/textures/kcdc/${shard}`]) {
    try {
      for (const n of f.readdirSync(d)) if (n.startsWith("ceka")) f.rmSync(`${d}/${n}`, { force: true });
    } catch {
      /* není */
    }
  }
  st.blank = sig;
  st.blankPend = true;
  blankGen = bump(shard);
}

function counts(): Map<string, number> {
  const c = new Map<string, number>();
  for (const s of Object.values(st.of)) c.set(s, (c.get(s) ?? 0) + 1);
  return c;
}

/** nový balíček: první číslo, které nemá žádná kresba ani složka */
function freshShard(c: Map<string, number>): string {
  const f = node()!;
  for (let n = 1; ; n++) {
    const name = shardName(n);
    if (!c.get(name) && !(st.hot ?? []).includes(name) && !f.existsSync(dirOf(name))) return name;
  }
}

/**
 * Kam s novou texturou:
 * * cold = false (za běhu): horký balíček s místem (`svet.horky`), jinak nový horký. Bez háku pro přenačtení
 *   (nic se za běhu nepřenačítá ani nepřelévá) mají horké balíčky plnou velikost `svet.shard` a plné se vyřadí.
 * * cold = true (start bez hráčů, přelévání): první studený balíček s dírou, jinak nový studený.
 */
export function pickShard(cold: boolean, c = counts()): string {
  const hot = st.hot ?? (st.hot = []);
  const full = Math.max(1, CFG.svet.shard);
  if (!cold) {
    const reloadable = canReload();
    const lim = reloadable ? hotSize() : full;
    if (!reloadable) for (let i = hot.length - 1; i >= 0; i--) if ((c.get(hot[i]) ?? 0) >= full) hot.splice(i, 1); // plný = studený
    for (const h of hot) if ((c.get(h) ?? 0) < lim) return h;
    const name = freshShard(c);
    hot.push(name);
    save();
    return name;
  }
  for (const s of shardsOnDisk()) if (s !== blankShard() && !hot.includes(s) && (c.get(s) ?? 0) < full) return s;
  return freshShard(c);
}

/**
 * Start serveru bez hráčů: kresby z horkých balíčků do studených (díry po smazaných, pak nové). Textura se přesune,
 * model a materiál se zapíšou znovu (nesou cestu balíčku). Přenačtení bez hráčů nikoho nezdrží.
 */
async function compact() {
  const hot = st.hot ?? [];
  const f = node()!;
  const c = counts();
  const ids = Object.keys(st.of)
    .map(Number)
    .filter((id) => hot.includes(st.of[id]))
    .sort((a, b) => a - b);
  if (!ids.length) return;
  let moved = 0;
  for (const id of ids) {
    const from = st.of[id];
    const src = `${dirOf(from)}/stream/textures/kcdc/${from}`;
    let files: string[] = [];
    try {
      files = f.readdirSync(src).filter((n) => n.startsWith(`k${id}.dds`));
    } catch {
      /* není */
    }
    c.set(from, (c.get(from) ?? 1) - 1);
    if (!files.includes(`k${id}.dds`)) {
      delete st.of[id]; // textura chybí: upeče se znovu (want při startu)
      continue;
    }
    const to = pickShard(true, c);
    ensureShard(to);
    for (const n of files) f.renameSync(`${src}/${n}`, `${dirOf(to)}/stream/textures/kcdc/${to}/${n}`);
    writeModel(to, "k" + id, true);
    for (const ext of [".cgf", ".cgfm", ".mtl"]) f.rmSync(`${dirOf(from)}/stream/objects/kcdc/${from}/k${id}${ext}`, { force: true });
    st.of[id] = to;
    c.set(to, (c.get(to) ?? 0) + 1);
    if (!st.pend.includes(id)) st.pend.push(id);
    wroteAt.set(id, bump(to));
    moved++;
  }
  // horké balíčky jsou teď prázdné a slouží dál (prázdný balíček se přenačítá levně)
  stats.moved += moved;
  // soubory už jsou přejmenované: st.of hned do úložiště (saveLater by po pádu před zápisem ukazoval na staré balíčky)
  save();
  await flush();
  log(`balíčky textur: ${moved} kreseb z horkých balíčků přesunuto do studených (start bez hráčů)`);
}

/** kresba visí: vykreslit (jednou) a dostat do balíčku; vrací Promise splněnou, až je soubor zapsaný */
export function want(drawingId: number, o: { start?: boolean } = {}): Promise<boolean> {
  if (!enabled) return Promise.resolve(false);
  const shard = st.of[drawingId];
  if (shard && node()!.existsSync(`${dirOf(shard)}/stream/textures/kcdc/${shard}/k${drawingId}.dds`)) return Promise.resolve(true);
  return new Promise((res) => {
    if (!queue.some((j) => j.id === drawingId) && current !== drawingId) queue.push({ id: drawingId, start: !!o.start });
    const prev = waiting.get(drawingId);
    waiting.set(drawingId, (ok) => (prev?.(ok), res(ok)));
    pump();
  });
}

function pump() {
  if (busy) return;
  if (!queue.length) {
    // zásobník bufferů (~50 MB) po chvíli nečinnosti pustit
    if (!idleTimer) idleTimer = setTimeout(() => ((idleTimer = null), drainPool()), 30000);
    return;
  }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  busy = true;
  const job = queue.shift()!;
  const id = job.id;
  current = id;
  cancelled = false;
  void (async () => {
    let ok = false;
    try {
      const rec = await fetchDrawing!(id);
      const d = rec && decode(rec.d, 16);
      if (d && !cancelled) {
        const t0 = Date.now();
        const k = (Math.max(1, Math.min(2, CFG.svet.kvalita)) * CFG.svet.sirka) / 768 / 1.5;
        const dds = await drive(bakeSteps(d, Math.max(0.5, k)));
        const cold = job.start && canReload() && countPlayers() === 0;
        const prev = st.of[id];
        const shard = prev && (cold || (st.hot ?? []).includes(prev)) ? prev : pickShard(cold);
        if (!cancelled) {
          ensureShard(shard);
          await writeSheet(shard, "k" + id, dds);
        }
        if (cancelled) removeFiles(shard, id);
        else {
          st.of[id] = shard;
          if (!st.pend.includes(id)) st.pend.push(id);
          wroteAt.set(id, bump(shard));
          stats.rendered++;
          stats.renderMs += Date.now() - t0;
          ok = true;
        }
      }
    } catch (e) {
      stats.lastError = String(e);
      log(`textura kresby ${id}: ${String(e)}`);
    }
    busy = false;
    current = -1;
    const cb = waiting.get(id);
    waiting.delete(id);
    cb?.(ok);
    pump();
  })();
}

function removeFiles(shard: string, drawingId: number) {
  const f = node()!;
  const dir = dirOf(shard);
  for (const ext of [".cgf", ".cgfm", ".mtl"]) {
    try {
      f.rmSync(`${dir}/stream/objects/kcdc/${shard}/k${drawingId}${ext}`, { force: true });
    } catch {
      /* není */
    }
  }
  const tex = `${dir}/stream/textures/kcdc/${shard}`;
  try {
    for (const n of f.readdirSync(tex)) if (n.startsWith(`k${drawingId}.dds`)) f.rmSync(`${tex}/${n}`, { force: true });
  } catch {
    /* není */
  }
}

/**
 * Kresba je smazaná natrvalo: soubory pryč. Balíček se kvůli tomu nepřenačítá (model nikdo nepoužívá); díra ve
 * studeném balíčku se zaplní při startu serveru, místo v horkém dostane další nová kresba.
 */
export function forget(drawingId: number) {
  const qi = queue.findIndex((j) => j.id === drawingId);
  if (qi >= 0) queue.splice(qi, 1);
  if (current === drawingId) cancelled = true;
  const shard = st.of[drawingId];
  if (!shard || !node()) return;
  removeFiles(shard, drawingId);
  delete st.of[drawingId];
  st.pend = st.pend.filter((x) => x !== drawingId);
  wroteAt.delete(drawingId);
  save();
}

// ---------------------------------------------------------------------------
// přenačtení balíčků

function scheduleReload() {
  if (reloadTimer) return;
  const wait = Math.max(1000, CFG.svet.reloadMs - (Date.now() - lastReload));
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void reload();
  }, Math.min(wait, CFG.svet.reloadMs));
}

let warned = false;
async function reload() {
  if (!st.dirty.length) return;
  lastReload = Date.now();
  const shards = [...st.dirty];
  const novych = shards.filter((s) => created.has(s));
  const zmenenych = shards.filter((s) => !created.has(s));
  stats.reloads++;
  // co je zapsané teď, to nový start balíčku ponese; co přijde potom, čeká na další přenačtení
  const mark = () => {
    for (const s of shards) sent.set(s, { gen: genOf(s), at: Date.now() });
    armWatch();
  };
  try {
    if (CFG.svet.reload) {
      mark();
      await CFG.svet.reload(novych, zmenenych);
      return;
    }
    if (CFG.svet.konzole) {
      mark();
      if (await viaConsole(novych, zmenenych)) return;
      for (const s of shards) sent.delete(s);
    }
  } catch (e) {
    log(`přenačtení balíčků: ${String(e)}`);
    return; // odeslané zůstane označené: po čase se zkusí znovu
  }
  if (!warned) {
    warned = true;
    log(`balíčky textur ${st.dirty.join(", ")} čekají na přenačtení: v konzoli serveru ${novych.length ? "refresh, " + novych.map((n) => "start " + n).join(", ") : ""}${zmenenych.map((n) => "restart " + n).join(", ")}; nebo nastavte KRESBY_CONFIG.svet.reload (jinak se ukážou po restartu serveru)`);
  }
}

/** hlídání odeslaných přenačtení: když resourceStart nepřijde, balíček zůstane rozepsaný a pošle se znovu */
function armWatch() {
  if (watchTimer || !sent.size) return;
  let next = Infinity;
  for (const [s, x] of sent) next = Math.min(next, x.at + reloadWait(s));
  watchTimer = setTimeout(checkSent, Math.max(1000, next - Date.now()));
}

function checkSent() {
  watchTimer = null;
  const t = Date.now();
  const stale: string[] = [];
  for (const [s, x] of sent) if (t - x.at >= reloadWait(s)) stale.push(s);
  for (const s of stale) {
    sent.delete(s);
    tries.set(s, (tries.get(s) ?? 0) + 1);
    stats.retries++;
    if (!st.dirty.includes(s)) st.dirty.push(s);
  }
  if (stale.length) {
    log(`balíček textur ${stale.join(", ")} se po přenačtení nespustil (resourceStart nepřišel), zkouším znovu`);
    save();
    scheduleReload();
  }
  armWatch();
}

/** konzole playgroundu (playground/host.mjs): port v logs/playground.pid, jeden řádek JSON { lines, waitMs } */
function viaConsole(novych: string[], zmenenych: string[]): Promise<boolean> {
  const f = node();
  if (!f || !net || !f.existsSync("logs/playground.pid")) return Promise.resolve(false);
  let port = 0;
  try {
    port = Number(JSON.parse(f.readFileSync("logs/playground.pid", "utf8")).consolePort) || 0;
  } catch {
    return Promise.resolve(false);
  }
  if (!port) return Promise.resolve(false);
  const lines = [...(novych.length ? ["refresh", ...novych.map((n) => "start " + n)] : []), ...zmenenych.map((n) => "restart " + n)];
  return new Promise((res) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(JSON.stringify({ lines, waitMs: 500 }) + "\n");
    });
    sock.on("data", () => {});
    sock.on("close", () => res(true));
    sock.on("error", () => res(false));
    sock.setTimeout(10000, () => (sock.destroy(), res(false)));
    log(`přenačítám balíčky textur: ${lines.join(", ")}`);
  });
}

/** resourceStart: balíček běží se soubory zapsanými do odeslání přenačtení (nebo do teď, když start nebyl náš) */
export function onResourceStart(name: string) {
  if (!name.startsWith(CFG.svet.predpona + "-")) return;
  created.delete(name);
  const s = sent.get(name);
  sent.delete(name);
  tries.delete(name);
  const upTo = s ? s.gen : genOf(name);
  const live: number[] = [];
  st.pend = st.pend.filter((id) => {
    if (st.of[id] !== name) return true;
    if ((wroteAt.get(id) ?? 0) > upTo) return true; // zapsaná až po odeslání: počká na další přenačtení
    wroteAt.delete(id);
    live.push(id);
    return false;
  });
  if (genOf(name) > upTo) markDirty(name);
  else st.dirty = st.dirty.filter((x) => x !== name);
  const blank = name === blankShard() && st.blankPend && blankGen <= upTo;
  if (blank) st.blankPend = false;
  save();
  // KCDC spustí skripty resource a balíček assetů zabalí až potom: Prop.spawn s jeho modelem jde o chvíli později
  if (live.length || blank) setTimeout(() => onLive?.(name, live), 1500);
}

/** pro testy */
export function resetForTests() {
  st = emptyState();
  created.clear();
  queue.length = 0;
  gen.clear();
  wroteAt.clear();
  sent.clear();
  tries.clear();
  blankGen = 0;
}
