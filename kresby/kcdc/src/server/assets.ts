// Textury kreseb jako streamované assety KCDC.
//
// KCDC neumí texturu ze skriptu za běhu, umí ale streamovat soubory z resource (`stream/`) a po restartu resource je
// klienti stáhnou a vymění "na místě" (docs: Custom assets, "A changed model, material or texture updates on screen").
// Kresby proto:
// 1. vykreslí pověšenou kresbu na serveru do rastru (server/raster.ts) a uloží jako DDS hry (server/dds.ts) spolu
//    s modelem listu a materiálem (server/cgf.ts),
// 2. soubory zapíšou do balíčků assetů = samostatných resource bez skriptů `<predpona>-<n>` ve složce resources serveru
//    (po `shard` kresbách, aby klient po nové kresbě stahoval jen jeden menší balíček; balíček 0 = prázdné listy),
// 3. požádají o přenačtení balíčku (hák `svet.reload`, nebo konzole playgroundu, nebo až restart serveru),
// 4. po `resourceStart` balíčku je textura u hráčů a server postaví list jako Prop s modelem kresby (server/props.ts).
//
// Serverové skripty KCDC mají Node (`require("fs")`, složka serveru = cwd), ověřeno na KCDC 1.7.1.

import { decode } from "../shared/codec";
import { LOOK } from "../shared/look";
import { sheetMaterial, sheetModel } from "./cgf";
import { CFG } from "./config";
import { writeDds } from "./dds";
import { renderSheet, resample, type Canvas } from "./raster";
import { storage } from "./most";

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
}

/** 2 = jednostranný materiál a rub listu (31. 10. 2026; dřív oboustranný, zezadu zrcadlová kresba) */
const VERZE_MODELU = 2;

const KEY = "kresby:obrazy";
let st: State = { v: 1, of: {}, pend: [], dirty: [], blank: "", blankPend: true };
const created = new Set<string>(); // nové složky balíčků (potřebují refresh + start)
const queue: number[] = [];
const waiting = new Map<number, (ok: boolean) => void>();
let busy = false;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let lastReload = 0;
let enabled = false;
let onLive: ((shard: string) => void) | null = null;
let fetchDrawing: ((id: number) => Promise<{ d: string; p: number } | null>) | null = null;
export const stats = { rendered: 0, renderMs: 0, bytes: 0, reloads: 0, lastError: "" };

const dirOf = (shard: string) => `${CFG.svet.slozka}/${shard}`;
export const shardName = (n: number) => `${CFG.svet.predpona}-${n}`;
export const blankShard = () => shardName(0);
export const modelPath = (shard: string, name: string) => `objects/kcdc/${shard}/${name}.cgf`;
export const texturePath = (shard: string, name: string) => `textures/kcdc/${shard}/${name}.dds`;
const GAME_SHEET = "objects/manmade/task_specific_props/read_and_write/scrolls/paper_a.cgf";

export const isEnabled = () => enabled;

function save() {
  void storage.set(KEY, st as any);
}

export async function init(cb: { onLive: (shard: string) => void; drawing: (id: number) => Promise<{ d: string; p: number } | null> }) {
  onLive = cb.onLive;
  fetchDrawing = cb.drawing;
  enabled = CFG.svet.rezim !== "cary" && !!node();
  if (!enabled) {
    if (CFG.svet.rezim !== "cary") log("textury kreseb nejdou: serverový skript nemá fs (require). Kresby ve světě jsou jen ladicí čáry.");
    return;
  }
  const saved = (await storage.get(KEY)) as State | undefined;
  if (saved && saved.v === 1) st = { v: 1, of: saved.of ?? {}, pend: saved.pend ?? [], dirty: saved.dirty ?? [], blank: saved.blank ?? "", blankPend: saved.blankPend ?? true, model: saved.model ?? 1 };
  // co je na disku a není rozepsané, to klienti mají (server balíčky zabalil při startu); rozepsané se přenačte
  const disk = new Set(shardsOnDisk());
  for (const [id, shard] of Object.entries(st.of)) if (!disk.has(shard)) delete st.of[id];
  ensureBlanks();
  aktualizovatModely();
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
      const name = x.slice(0, -4);
      const { cgf, cgfm } = sheetModel(`objects/kcdc/${shard}/${name}`);
      f.writeFileSync(`${dir}/${name}.cgf`, cgf);
      f.writeFileSync(`${dir}/${name}.cgfm`, cgfm);
      f.writeFileSync(`${dir}/${name}.mtl`, sheetMaterial(texturePath(shard, name), { shininess: CFG.svet.lesk }));
      n++;
    }
    if (soubory.length) markDirty(shard);
  }
  st.model = VERZE_MODELU;
  save();
  if (n) log(`modely listů: ${n} přepsáno na verzi ${VERZE_MODELU} (jednostranný list s rubem)`);
}

function shardsOnDisk(): string[] {
  const f = node();
  if (!f || !f.existsSync(CFG.svet.slozka)) return [];
  return f.readdirSync(CFG.svet.slozka).filter((n) => n.startsWith(CFG.svet.predpona + "-") && f.existsSync(`${dirOf(n)}/package.json`));
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

// ---------------------------------------------------------------------------
// vykreslení

function texture(cv: Canvas) {
  const w = Math.max(64, Math.min(4096, 2 ** Math.round(Math.log2(CFG.svet.sirka || 1024))));
  return resample(cv, w, w / 2);
}

function writeSheet(shard: string, name: string, cv: Canvas) {
  const f = node()!;
  const dir = dirOf(shard);
  const dds = writeDds(texture(cv));
  for (const [ext, bytes] of dds.files) f.writeFileSync(`${dir}/stream/textures/kcdc/${shard}/${name}.dds${ext ? "." + ext : ""}`, bytes);
  const { cgf, cgfm } = sheetModel(`objects/kcdc/${shard}/${name}`);
  f.writeFileSync(`${dir}/stream/objects/kcdc/${shard}/${name}.cgf`, cgf);
  f.writeFileSync(`${dir}/stream/objects/kcdc/${shard}/${name}.cgfm`, cgfm);
  f.writeFileSync(`${dir}/stream/objects/kcdc/${shard}/${name}.mtl`, sheetMaterial(texturePath(shard, name), { shininess: CFG.svet.lesk }));
  stats.bytes += dds.bytes + cgf.length + cgfm.length;
}

/** prázdné listy pro všechny druhy papíru (balíček 0); znovu, když se v nastavení změní papíry */
export function ensureBlanks() {
  if (!enabled) return;
  const sig = JSON.stringify(["list3", LOOK.papers.map((p) => [p.kod, p.rgb, p.styl]), CFG.svet.sirka, CFG.svet.lesk]);
  const shard = blankShard();
  if (st.blank === sig && node()!.existsSync(`${dirOf(shard)}/package.json`)) return;
  ensureShard(shard);
  for (const p of LOOK.papers) {
    const g = renderSheet({ paper: p.kod, inks: [], strokes: [] }, Math.max(0.5, CFG.svet.sirka / 768 / 2), 1e12);
    let r = g.next();
    while (!r.done) r = g.next();
    writeSheet(shard, "list" + p.kod, r.value);
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
  markDirty(shard);
}

function pickShard(): string {
  const counts = new Map<string, number>();
  for (const s of Object.values(st.of)) counts.set(s, (counts.get(s) ?? 0) + 1);
  for (let n = 1; ; n++) {
    const name = shardName(n);
    if ((counts.get(name) ?? 0) < Math.max(1, CFG.svet.shard)) return name;
  }
}

/** kresba visí: vykreslit (jednou) a dostat do balíčku; vrací Promise splněnou, až je soubor zapsaný */
export function want(drawingId: number): Promise<boolean> {
  if (!enabled) return Promise.resolve(false);
  const shard = st.of[drawingId];
  if (shard && node()!.existsSync(`${dirOf(shard)}/stream/textures/kcdc/${shard}/k${drawingId}.dds`)) return Promise.resolve(true);
  return new Promise((res) => {
    if (!queue.includes(drawingId)) queue.push(drawingId);
    const prev = waiting.get(drawingId);
    waiting.set(drawingId, (ok) => (prev?.(ok), res(ok)));
    pump();
  });
}

function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const id = queue.shift()!;
  void (async () => {
    let ok = false;
    try {
      const rec = await fetchDrawing!(id);
      const d = rec && decode(rec.d, 16);
      if (d) {
        const t0 = Date.now();
        const k = (Math.max(1, Math.min(2, CFG.svet.kvalita)) * CFG.svet.sirka) / 768 / 1.5;
        const g = renderSheet(d, Math.max(0.5, k), 4000);
        let r = g.next();
        let sliceStart = Date.now();
        while (!r.done) {
          if (Date.now() - sliceStart >= CFG.svet.rozpocetMs) {
            await new Promise((x) => setTimeout(x, 0)); // vrátit tick serveru
            sliceStart = Date.now();
          }
          r = g.next();
        }
        const shard = st.of[id] ?? pickShard();
        ensureShard(shard);
        writeSheet(shard, "k" + id, r.value);
        st.of[id] = shard;
        if (!st.pend.includes(id)) st.pend.push(id);
        stats.rendered++;
        stats.renderMs += Date.now() - t0;
        markDirty(shard);
        ok = true;
      }
    } catch (e) {
      stats.lastError = String(e);
      log(`textura kresby ${id}: ${String(e)}`);
    }
    busy = false;
    const cb = waiting.get(id);
    waiting.delete(id);
    cb?.(ok);
    pump();
  })();
}

/** kresba je smazaná natrvalo: soubory pryč (balíček se přenačte s dalším) */
export function forget(drawingId: number) {
  const shard = st.of[drawingId];
  if (!shard || !node()) return;
  const f = node()!;
  const dir = dirOf(shard);
  for (const p of [`stream/objects/kcdc/${shard}/k${drawingId}.cgf`, `stream/objects/kcdc/${shard}/k${drawingId}.cgfm`, `stream/objects/kcdc/${shard}/k${drawingId}.mtl`]) {
    try {
      f.rmSync(`${dir}/${p}`, { force: true });
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
  delete st.of[drawingId];
  st.pend = st.pend.filter((x) => x !== drawingId);
  if (!st.dirty.includes(shard)) st.dirty.push(shard);
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
  const novych = st.dirty.filter((s) => created.has(s));
  const zmenenych = st.dirty.filter((s) => !created.has(s));
  stats.reloads++;
  try {
    if (CFG.svet.reload) {
      await CFG.svet.reload(novych, zmenenych);
      return;
    }
    if (CFG.svet.konzole && (await viaConsole(novych, zmenenych))) return;
  } catch (e) {
    log(`přenačtení balíčků: ${String(e)}`);
  }
  if (!warned) {
    warned = true;
    log(`balíčky textur ${st.dirty.join(", ")} čekají na přenačtení: v konzoli serveru ${novych.length ? "refresh, " + novych.map((n) => "start " + n).join(", ") : ""}${zmenenych.map((n) => "restart " + n).join(", ")}; nebo nastavte KRESBY_CONFIG.svet.reload (jinak se ukážou po restartu serveru)`);
  }
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

/** resourceStart: balíček běží s novými soubory */
export function onResourceStart(name: string) {
  if (!name.startsWith(CFG.svet.predpona + "-")) return;
  created.delete(name);
  st.dirty = st.dirty.filter((x) => x !== name);
  st.pend = st.pend.filter((id) => st.of[id] !== name);
  if (name === blankShard()) st.blankPend = false;
  save();
  // KCDC spustí skripty resource a balíček assetů zabalí až potom: Prop.spawn s jeho modelem jde o chvíli později
  setTimeout(() => onLive?.(name), 1500);
}

/** pro testy */
export function resetForTests() {
  st = { v: 1, of: {}, pend: [], dirty: [], blank: "", blankPend: true };
  created.clear();
  queue.length = 0;
}
