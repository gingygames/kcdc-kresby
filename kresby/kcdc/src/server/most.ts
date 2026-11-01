// Napojení na resource "most" (most na frameworky serveru, kontrakt ../../../most/src/shared/contract.ts, verze 1)
// s nativním záložním chováním. Kresby volají jen tyhle funkce.
//
// API mostu se čte přes jeho shim (../../../../most/shim/most.ts: Exports.get("most", "api") při každém volání,
// po restartu mostu tedy nový objekt). Když most běží, přednost má on: identita, práva, ekonomika, obyčejné
// předměty, nabídky, oznámení a úložiště jdou přes framework serveru. Když most chybí nebo část nemá (hodí výjimku):
//   identity.getCharacterId / getName -> KRESBY_CONFIG.identity, jinak shim ("steam:<id>", jinak "nick:<přezdívka malými>")
//   perms.has                         -> KRESBY_CONFIG.isAdmin / admini (přezdívky)
//   notify                            -> oznámení hry v klientu (Hud.showNotification)
//   ui.menu                           -> herní dialog (Dialogue), stránkovaný po 6 volbách
//   storage.get/set/delete/keys       -> KRESBY_CONFIG.storage, jinak shim: soubor <server>/data/most-shim/kresby.json (fs)
//   inventory.has/count/give/take     -> Inventory (KCDC) pro obyčejné herní předměty (brky, uhel, lahvičky, suroviny)
//   inventory.registerCustomItem      -> registruje most (bez něj shim); GUID se pak jen přečte stejnou definicí
//   economy.remove                    -> jen kram: "menu"; nativní obchod hry (Vendor) počítá v groších hry
// Předměty s vlastními daty (lahvička inkoustu s kapkami, kresba) čte a mění vždy nativní Inventory po řádcích
// (updateCustom, remove podle id řádku) - kontrakt mostu řádky neupravuje. Viz AGENTS.md.

import { configureMostFallback, hasMost as shimHasMost, most as mostApi } from "../../../../most/shim/most";
import { CFG, type Storage } from "./config";

export interface MenuOption {
  id: string;
  text: string;
  enabled?: boolean;
}

export interface MenuSpec {
  title?: string;
  text?: string;
  options: MenuOption[];
}

type Fn = (...a: any[]) => any;
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const log = (t: string) => console.log("[kresby] " + t);

/** API mostu, jen když most opravdu běží (záloha shimu se používá cíleně níž) */
const live = (): Record<string, any> | null => (shimHasMost() ? (mostApi() as unknown as Record<string, any>) : null);
/** záloha shimu (most neběží): identita, úložiště do souboru, registrace předmětů */
const shim = () => mostApi() as unknown as Record<string, any>;

function exported(resource: string, name: string): unknown {
  try {
    return Exports.get(resource, name);
  } catch {
    return undefined; // resource neběží
  }
}

/** stav napojení (most a sprava se čtou při každém volání; tohle jen hlásí, co právě běží) */
export function resolveBridges(): { most: boolean; sprava: boolean } {
  configureMostFallback({ perms: (p) => nativeAdmin(p), log: (m) => log("most-shim: " + m) });
  return { most: shimHasMost(), sprava: typeof exported("sprava", "registerPanel") === "function" };
}

/** funkce mostu: most.<group>.<name>, nebo most.<name> pro group "" */
function fn(group: string, name: string): Fn | null {
  const most = live();
  if (!most) return null;
  if (!group) return typeof most[name] === "function" ? (most[name] as Fn) : null;
  const g = most[group];
  const f = g && typeof g === "object" ? g[name] : most[group + "." + name];
  return typeof f === "function" ? (f as Fn).bind(g) : null;
}

async function call<T>(group: string, name: string, args: unknown[], fallback: () => T | Promise<T>, accept: (v: unknown) => boolean = () => true): Promise<T> {
  const f = fn(group, name);
  if (f) {
    try {
      const v = await f(...args);
      if (accept(v)) return v as T;
    } catch (e) {
      log(`most.${group ? group + "." : ""}${name}: ${String(e)} - použije se nativní`);
    }
  }
  return fallback();
}

export const hasMost = () => shimHasMost();
export const mostHas = (group: string, name: string) => !!fn(group, name);
export const mostInfo = (): string => {
  const f = fn("", "info");
  try {
    const i = f && f();
    return i ? `most ${i.version ?? ""} (adaptér ${i.adapter ?? "?"}, kontrakt ${i.contract ?? "?"})` : live() ? "most (bez info)" : "bez mostu";
  } catch {
    return "most (info selhalo)";
  }
};

// ---------------------------------------------------------------------------
// identita a práva

/** bez mostu: KRESBY_CONFIG.identity, jinak shim mostu - stejné id postavy jako standalone most (steam: / nick: malými) */
function nativeId(p: Player) {
  if (CFG.identity) return CFG.identity(p);
  let id: unknown = null;
  try {
    id = shim().identity.getCharacterId(p.id);
  } catch {
    /* shim selhal */
  }
  return { id: typeof id === "string" && id ? id : "nick:" + p.nickname.toLowerCase(), name: p.nickname };
}

export async function charId(p: Player): Promise<string> {
  return call("identity", "getCharacterId", [p.id], () => nativeId(p).id, (v) => typeof v === "string" && v.length > 0);
}

export async function charName(p: Player): Promise<string> {
  return call("identity", "getName", [p.id], () => nativeId(p).name, (v) => typeof v === "string" && v.length > 0);
}

function nativeAdmin(p: Player): boolean {
  if (CFG.isAdmin) return !!CFG.isAdmin(p);
  return CFG.admini.map((a) => a.toLowerCase()).includes(p.nickname.toLowerCase());
}

const one = (p: Player, perm: string) => call("perms", "has", [p.id, perm], () => nativeAdmin(p), (v) => typeof v === "boolean").then((v) => !!v);

/**
 * perm: "kresby.admin" (desky, materiál, krám), "kresby.moderate" (skrýt / smazat cizí kresby).
 * Stačí i obecné "admin" mostu; moderovat smí i ten, kdo má "kresby.admin".
 */
export async function can(p: Player, perm: string): Promise<boolean> {
  const list = perm === "kresby.moderate" ? ["kresby.moderate", "kresby.admin", "admin"] : perm === "kresby.admin" ? ["kresby.admin", "admin"] : [perm];
  for (const x of list) if (await one(p, x)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// oznámení a nabídky

export async function notify(p: Player, text: string, kind: "info" | "success" | "warning" | "error" = "info"): Promise<void> {
  await call("", "notify", [p.id, text, kind], () => p.emit("kresby:info", JSON.stringify({ text, kind })));
}

interface Pending {
  player: number;
  pages: MenuOption[][];
  page: number;
  spec: MenuSpec;
  done: (id: string | null) => void;
}
const dialogs = new Map<number, Pending>();
const PER_PAGE = 6;

function pageOf(d: Pending) {
  const opts = d.pages[d.page].map((o) => ({ id: "o:" + o.id, text: o.text, enabled: o.enabled !== false }));
  if (d.page < d.pages.length - 1) opts.push({ id: "#dalsi", text: "Další…", enabled: true });
  if (d.page > 0) opts.push({ id: "#zpet", text: "Předchozí…", enabled: true });
  const line = d.spec.title ? d.spec.title + (d.spec.text ? "\n" + d.spec.text : "") : (d.spec.text ?? "");
  return { line, options: opts };
}

function nativeMenu(p: Player, spec: MenuSpec): Promise<string | null> {
  const pages: MenuOption[][] = [];
  for (let i = 0; i < spec.options.length; i += PER_PAGE) pages.push(spec.options.slice(i, i + PER_PAGE));
  if (!pages.length) pages.push([{ id: "#zavrit", text: "Zavřít" }]);
  return new Promise((resolve) => {
    for (const [k, v] of dialogs) if (v.player === p.id) (dialogs.delete(k), v.done(null));
    const d: Pending = { player: p.id, pages, page: 0, spec, done: resolve };
    const s = Dialogue.open(p.id, pageOf(d));
    if (!s) return resolve(null);
    dialogs.set(s, d);
  });
}

/** nabídka: vrátí id zvolené položky, nebo null (zavřeno) */
export async function menu(p: Player, spec: MenuSpec): Promise<string | null> {
  return call("ui", "menu", [p.id, spec], () => nativeMenu(p, spec), (v) => v === null || typeof v === "string").then((v) =>
    v === "#zavrit" ? null : (v as string | null),
  );
}

export function closeMenus(p: Player) {
  for (const [k, v] of dialogs) {
    if (v.player === p.id) {
      dialogs.delete(k);
      Dialogue.close(k);
      v.done(null);
    }
  }
}

export function onDialogueChoice(session: number, _p: Player, optionId: string) {
  const d = dialogs.get(session);
  if (!d) return;
  if (optionId === "#dalsi" || optionId === "#zpet") {
    d.page += optionId === "#dalsi" ? 1 : -1;
    Dialogue.update(session, pageOf(d));
    return;
  }
  dialogs.delete(session);
  Dialogue.close(session);
  d.done(optionId.startsWith("o:") ? optionId.slice(2) : null);
}

export function onDialogueClosed(session: number) {
  const d = dialogs.get(session);
  if (!d) return;
  dialogs.delete(session);
  d.done(null);
}

// ---------------------------------------------------------------------------
// úložiště: klíče "kresby:<cokoli>" (kontrakt: část před první dvojtečkou = jmenný prostor)

let warned = false;

function nativeStorage(): Required<Storage> {
  const c = CFG.storage;
  if (c) {
    return {
      get: (k) => c.get(k),
      set: (k, v) => c.set(k, v),
      delete: (k) => (c.delete ? c.delete(k) : c.set(k, null)),
      keys: (prefix) => (c.keys ? c.keys(prefix) : []),
    };
  }
  if (!warned) {
    warned = true;
    log("most neběží: úložiště je záloha shimu mostu (data/most-shim/kresby.json, bez fs jen paměť)");
  }
  const st = shim().storage;
  return {
    get: (k) => st.get(k),
    set: (k, v) => st.set(k, v as Json),
    delete: (k) => st.delete(k),
    keys: (prefix) => st.keys(prefix),
  };
}

export const storage = {
  get: (key: string): Promise<unknown> => call("storage", "get", [key], () => nativeStorage().get(key)),
  set: (key: string, value: Json): Promise<boolean> =>
    call("storage", "set", [key, value], () => nativeStorage().set(key, value), (v) => v !== false).then((v) => v !== false),
  delete: (key: string): Promise<unknown> => call("storage", "delete", [key], () => nativeStorage().delete(key)),
  keys: (prefix: string): Promise<string[]> =>
    call("storage", "keys", [prefix], () => nativeStorage().keys(prefix), Array.isArray).then((v) => (Array.isArray(v) ? (v as string[]) : [])),
  kind: () => (fn("storage", "get") ? "most" : CFG.storage ? "config" : "shim"),
};

// ---------------------------------------------------------------------------
// inventář: obyčejné herní předměty přes most, řádky s daty předmětu nativně

export interface Meta {
  name?: string;
  description?: string;
  data?: Record<string, unknown>;
}

export const rows = (p: Player): InventoryRow[] => Inventory.get(p)?.items ?? [];

export function customData(r: InventoryRow): Record<string, any> | null {
  const c = (r.metadata as any)?.custom;
  return c && typeof c.data === "object" && c.data ? (c.data as Record<string, any>) : null;
}

export function customName(r: InventoryRow): string | null {
  const c = (r.metadata as any)?.custom;
  return c && typeof c.name === "string" ? c.name : null;
}

const plainRow = (r: InventoryRow, want: string) => (r.name.toLowerCase() === want || r.item.toLowerCase() === want) && !(r.metadata as any)?.custom?.data;

function nativeCount(p: Player, item: string): number {
  const want = item.toLowerCase();
  let n = 0;
  for (const r of rows(p)) if (plainRow(r, want)) n += r.amount;
  return n;
}

/** kolik má hráč obyčejného herního předmětu */
export async function count(p: Player, item: string): Promise<number> {
  return call("inventory", "count", [p.id, item], () => nativeCount(p, item), (v) => typeof v === "number").then((v) => Number(v) || 0);
}

export async function give(p: Player, item: string, amount: number): Promise<boolean> {
  return call("inventory", "give", [p.id, item, amount], () => Inventory.add(p, { item, amount }).ok, (v) => typeof v === "boolean").then((v) => !!v);
}

export async function take(p: Player, item: string, amount: number): Promise<boolean> {
  if (amount <= 0) return true;
  return call("inventory", "take", [p.id, item, amount], () => {
    const want = item.toLowerCase();
    const units: InventoryUnit[] = [];
    let left = amount;
    for (const r of rows(p)) {
      if (left <= 0) break;
      if (!plainRow(r, want)) continue;
      const n = Math.min(left, r.amount);
      units.push({ id: r.id, amount: n });
      left -= n;
    }
    return left <= 0 && Inventory.remove(p, { units }).ok;
  }, (v) => typeof v === "boolean").then((v) => !!v);
}

/** předmět s daty: vlastní typ (guid) s názvem, popisem a daty tohoto kusu */
export function giveCustom(p: Player, guid: string, meta: Meta, amount = 1): boolean {
  const r = Inventory.add(p, { item: guid, amount, metadata: { custom: meta } });
  if (!r.ok) log(`předmět ${meta.name ?? guid} pro ${p.nickname}: ${r.code}`);
  return r.ok;
}

export function takeRow(p: Player, rowId: string, amount = 1): boolean {
  return Inventory.remove(p, { units: [{ id: rowId, amount }] }).ok;
}

export function updateRow(p: Player, rowId: string, meta: Meta): boolean {
  return Inventory.updateCustom(p, { id: rowId, ...meta }).ok;
}

/**
 * Vlastní předmět registruje jen most (bez něj jeho shim) - kontrakt CustomItemDef se vzhledem `visual`
 * (drobnost, materiál nebo dokument hry). GUID kontrakt nevrací, a tak se pak přečte z Items.register se stejnou
 * definicí, jakou most předává (dokumentace KCDC: "Identical repeats succeed", nic se neregistruje podruhé).
 */
export function registerCustomItem(id: string, base: string, def: { name: string; description?: string; visual: string; weight: number; price?: number; stackable?: boolean; usable?: boolean; useLabel?: string }): string {
  // běžící most bez téhle části (adaptér frameworku bez vlastních předmětů): jediná registrace je Items.register níž
  const reg = fn("inventory", "registerCustomItem") ?? (live() ? (() => true) : (d: unknown) => shim().inventory.registerCustomItem(d));
  let ok: unknown = false;
  try {
    ok = reg({ id, base, ...def });
  } catch (e) {
    log(`registerCustomItem ${id}: ${String(e)}`);
  }
  if (ok && typeof (ok as Promise<unknown>).then === "function") (ok as Promise<unknown>).catch((e) => log(`registerCustomItem ${id}: ${String(e)}`));
  else if (ok === false) throw new Error(`most odmítl typ ${id} (vzhled ${def.visual})`);
  // stejná definice jako v mostu (most/adapters/standalone/inventory.ts): GUID existujícího typu
  return Items.register(id, { name: def.name, description: def.description, visual: def.visual, weight: def.weight, price: def.price, stackable: def.stackable, usable: def.usable, useLabel: def.useLabel });
}

// ---------------------------------------------------------------------------
// ekonomika (jen kram: "menu")

export async function pay(p: Player, amount: number, reason: string): Promise<boolean> {
  if (amount <= 0) return true;
  const id = await charId(p);
  return call("economy", "remove", [id, amount, undefined, reason], () => take(p, "money", amount), (v) => typeof v === "boolean").then((v) => !!v);
}

// ---------------------------------------------------------------------------
// sprava (admin UI): Exports.get("sprava", "registerPanel")(def, "kresby"); sprava si panely umí i sama vzít
// z exportu "spravaPanels" (viz server/admin.ts)

export function registerPanel(panel: unknown): boolean {
  const f = exported("sprava", "registerPanel");
  if (typeof f !== "function") return false;
  try {
    (f as Fn)(panel, "kresby");
    return true;
  } catch (e) {
    log("sprava.registerPanel: " + String(e));
    return false;
  }
}
