// Shim mostu pro serverovou část modulu KCDC. Import relativní cestou (esbuild ho přibalí), nebo zkopírovat.
//
//   import { most, configureMostFallback } from "../../../most/shim/most";
//   configureMostFallback({ perms: (p, perm) => CFG.admini.includes(p.nickname) });   // jen pro chod bez mostu
//   if (await most().perms.has(p.id, "loutna.admin")) …
//   await most().storage.set("kresby:vyveska/3", data);
//
// Běží-li resource "most", vrátí jeho API (Exports.get("most", "api"), čte se při každém volání – po restartu mostu
// je nový objekt). Jinak vrátí nativní zálohu: groše a inventář hry, Chat, Dialogue (max 8 voleb), úložiště
// do <server>/data/most-shim/<prostor>.json (serverové skripty KCDC mají require("fs")), práva podle configureMostFallback.
// Manifest modulu: "resourceDependencies": [{ "name": "most", "optional": true }].
import type {
  CustomItemDef, InventoryEntry, JsonValue, MenuSpec, MostApi, NotifyKind, PromptSpec,
} from "../src/shared/contract";
import { registerItemType } from "../src/shared/items";

declare const require: ((id: string) => any) | undefined;

const MONEY = "5ef63059-322e-4e1b-abe8-926e100c770e";
let missingUntil = 0;
let fallbackOpts: { perms?: (player: Player, perm: string) => boolean; dataDir?: string; log?: (m: string) => void } = {};

/** Jak se má záloha chovat bez mostu (práva, kam ukládat). */
export function configureMostFallback(opts: typeof fallbackOpts) {
  fallbackOpts = { ...fallbackOpts, ...opts };
}

/** Běží most? */
export function hasMost(): boolean {
  return most() !== fallback;
}

/** API mostu, nebo nativní záloha. */
export function most(): MostApi {
  if (Date.now() >= missingUntil) {
    try {
      const api = Exports.get("most", "api") as MostApi | undefined;
      if (api) return api;
    } catch {}
    missingUntil = Date.now() + 5000; // Exports.get na chybějící resource hází: nezkoušet při každém volání
  }
  return fallback;
}
// most nastartoval později: hned ho používat
Events.on("resourceStart", (name: string) => void (name === "most" && (missingUntil = 0)));

// ------------------------------------------------------------------ nativní záloha
const log = (m: string) => (fallbackOpts.log ?? ((x: string) => console.log(`[most-shim] ${x}`)))(m);
const byId = (id: number) => Player.getById(id);
const charOf = (p: Player) => (p.steamId ? "steam:" + p.steamId : "nick:" + p.nickname.toLowerCase());
const playerOfChar = (charId: string) => Player.all().find((p) => charOf(p) === charId) ?? null;
const customs = new Map<string, { def: CustomItemDef; guid: string | null }>();
const tag = (r: InventoryRow) => [...customs.values()].find((c) => c.guid === r.item.toLowerCase())?.def.id ?? null;
const rows = (p: Player) => Inventory.get(p)?.items ?? [];
function matches(r: InventoryRow, itemId: string) {
  const c = customs.get(itemId);
  if (c?.guid) return r.item.toLowerCase() === c.guid;
  const id = (c ? c.def.base : itemId).toLowerCase();
  return r.item.toLowerCase() === id || r.name.toLowerCase() === id;
}
const count = (p: Player, itemId: string) => rows(p).filter((r) => matches(r, itemId)).reduce((s, r) => s + r.amount, 0);
function takeUnits(p: Player, pick: (r: InventoryRow) => boolean, n: number) {
  const units: InventoryUnit[] = [];
  for (const r of rows(p)) {
    if (n <= 0) break;
    if (!pick(r)) continue;
    const k = Math.min(r.amount, n);
    units.push({ id: r.id, amount: k });
    n -= k;
  }
  return n > 0 ? false : Inventory.remove(p, { units }).ok;
}

// úložiště: soubor na jmenný prostor, jinak paměť
const fs = (() => {
  try {
    const req = typeof require === "function" ? require : undefined;
    return req ? req("node:fs") : null;
  } catch {
    return null;
  }
})();
const spaces = new Map<string, Record<string, JsonValue>>();
const nsOf = (key: string) => (typeof key === "string" && key.indexOf(":") > 0 ? key.slice(0, key.indexOf(":")) : null);
const dir = () => fallbackOpts.dataDir ?? "data/most-shim";
function space(ns: string): Record<string, JsonValue> {
  const known = spaces.get(ns);
  if (known) return known;
  let s: Record<string, JsonValue> = {};
  try {
    if (fs?.existsSync(`${dir()}/${ns}.json`)) s = JSON.parse(fs.readFileSync(`${dir()}/${ns}.json`, "utf8"));
  } catch (e) {
    log(`čtení ${ns}: ${e}`);
  }
  spaces.set(ns, s);
  return s;
}
// zápis prostoru se slučuje: první hned, další nejdřív za WRITE_MS (dřív se celý soubor, u kreseb ~1,6 MB, psal
// při každém set; dávka 50 klíčů = 50 zápisů). Při zastavení kteréhokoli resource se dopíše hned.
const WRITE_MS = 1000;
const lastWrite = new Map<string, number>();
const pendingWrite = new Map<string, ReturnType<typeof setTimeout>>();
function persist(ns: string) {
  if (!fs || pendingWrite.has(ns)) return;
  const wait = (lastWrite.get(ns) ?? -Infinity) + WRITE_MS - Date.now();
  if (wait <= 0) return writeSpace(ns);
  pendingWrite.set(ns, setTimeout(() => writeSpace(ns), wait));
}
Events.on("resourceStop", () => {
  for (const ns of [...pendingWrite.keys()]) writeSpace(ns);
});
function writeSpace(ns: string) {
  const t = pendingWrite.get(ns);
  if (t !== undefined) clearTimeout(t);
  pendingWrite.delete(ns);
  lastWrite.set(ns, Date.now());
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(`${dir()}/${ns}.json.tmp`, JSON.stringify(space(ns)));
    fs.renameSync(`${dir()}/${ns}.json.tmp`, `${dir()}/${ns}.json`);
  } catch (e) {
    log(`zápis ${ns}: ${e}`);
  }
}

// nabídky přes herní dialog
const menus = new Map<number, (id: string | null) => void>();
let menuEvents = false;
function menu(pid: number, spec: MenuSpec): Promise<string | null> {
  if (!menuEvents) {
    menuEvents = true;
    Events.on("dialogueChoice", (s: number, _p: Player, id: string) => {
      const r = menus.get(s);
      if (r) menus.delete(s), Dialogue.close(s), r(id);
    });
    Events.on("dialogueClosed", (s: number) => {
      const r = menus.get(s);
      if (r) menus.delete(s), r(null);
    });
  }
  if (spec.options.length > 8) log(`menu má ${spec.options.length} voleb, bez mostu ukazuji prvních 8`);
  return new Promise((resolve) => {
    const line = [spec.title, spec.text].filter(Boolean).join("\n") || undefined;
    const s = Dialogue.open(pid, { line, onRight: spec.onRight, options: spec.options.slice(0, 8) });
    if (!s) return resolve(null);
    menus.set(s, resolve);
  });
}

const fallback: MostApi = {
  info: () => ({ contract: 1, version: "shim", adapter: "shim (most neběží)", overrides: {} }),
  identity: {
    getCharacterId: (pid) => {
      const p = byId(pid);
      return p ? charOf(p) : null;
    },
    getName: (pid) => byId(pid)?.nickname ?? null,
    getPlayerId: (charId) => playerOfChar(charId)?.id ?? null,
  },
  perms: {
    has: (pid, perm) => {
      const p = byId(pid);
      return !!p && !!fallbackOpts.perms?.(p, perm);
    },
  },
  economy: {
    defaultCurrency: "groschen",
    currencies: () => [{ id: "groschen", label: "grošů", native: true }],
    getBalance: (charId, c = "groschen") => {
      const p = c === "groschen" ? playerOfChar(charId) : null;
      return p ? rows(p).filter((r) => r.item.toLowerCase() === MONEY).reduce((s, r) => s + r.amount, 0) : 0;
    },
    canAfford: (charId, amount, c) => (fallback.economy.getBalance(charId, c) as number) >= amount,
    add: (charId, amount, c = "groschen") => {
      const p = c === "groschen" && amount >= 0 ? playerOfChar(charId) : null;
      return !!p && (amount === 0 || Inventory.add(p, { item: MONEY, amount: Math.min(10000, Math.floor(amount)) }).ok);
    },
    remove: (charId, amount, c = "groschen") => {
      const p = c === "groschen" && amount >= 0 ? playerOfChar(charId) : null;
      return !!p && takeUnits(p, (r) => r.item.toLowerCase() === MONEY, Math.floor(amount));
    },
  },
  inventory: {
    has: (pid, itemId, n = 1) => {
      const p = byId(pid);
      return !!p && count(p, itemId) >= n;
    },
    count: (pid, itemId) => {
      const p = byId(pid);
      return p ? count(p, itemId) : 0;
    },
    give: (pid, itemId, n = 1, data) => {
      const p = byId(pid);
      if (!p || !(n > 0)) return false;
      const c = customs.get(itemId);
      // quality / health / condition = nativní vlastnosti kusu (health a condition naráz KCDC odmítne: vyhrává condition)
      const rest: Record<string, unknown> = { ...(c?.def.data ?? {}), ...(data ?? {}) };
      const meta: Record<string, unknown> = {};
      for (const k of ["quality", "health", "condition"]) {
        if (typeof rest[k] === "number") meta[k] = k === "quality" ? Math.floor(rest[k] as number) : rest[k];
        delete rest[k];
      }
      if ("condition" in meta) delete meta.health;
      if (c?.guid && Object.keys(rest).length) meta.custom = { data: rest };
      const item = !c ? itemId : (c.guid ?? c.def.base); // bez guid: KCDC nepřejmenuje nativní kus
      return Inventory.add(p, { item, amount: Math.floor(n), metadata: Object.keys(meta).length ? meta : undefined }).ok;
    },
    take: (pid, itemId, n = 1) => {
      const p = byId(pid);
      return !!p && n > 0 && takeUnits(p, (r) => matches(r, itemId), Math.floor(n));
    },
    list: (pid): InventoryEntry[] => {
      const p = byId(pid);
      return p
        ? rows(p).map((r) => ({ row: r.id, item: r.item, name: r.name, custom: tag(r), amount: r.amount, label: ((r.metadata?.custom as any)?.name as string) ?? null, data: ((r.metadata?.custom as any)?.data as Record<string, unknown>) ?? null }))
        : [];
    },
    registerCustomItem: (raw) => {
      // KCDC 1.7.1: zalomení řádku v názvu/popisu = "Invalid custom item text"
      const one = (s?: string) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim() : s);
      const def = { ...raw, name: one(raw.name)!, description: one(raw.description), useLabel: one(raw.useLabel) };
      // s vlastním modelem/ikonou (KCDC 1.7.2+), pak bez nich s visual ?? base (1.7.1); typ je v běhu serveru
      // neměnný: změněná definice nechá dosavadní typ (GUID) a projeví se po restartu serveru
      const prev = customs.get(def.id)?.def;
      const res = registerItemType(def.id, def, prev ? [prev] : []);
      let guid: string | null = null;
      if (res.kind !== "failed") {
        guid = res.guid;
        if (res.kind === "pending") log(`vzhled ${def.id} se změní po restartu serveru`);
      } else {
        log(`Items.register(${def.id}): ${res.errors[0]}` + (def.visual || def.model || res.conflict ? "" : `; dávám obyčejný ${def.base}`));
        if (def.visual || def.model || res.conflict) return false;
      }
      customs.set(def.id, { def, guid });
      return true;
    },
    getCustomItem: (id) => customs.get(id)?.def ?? null,
  },
  storage: {
    get: (key) => {
      const ns = nsOf(key);
      const v = ns ? space(ns)[key] : undefined;
      return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    },
    set: (key, value) => {
      const ns = nsOf(key);
      if (!ns) return false;
      if (value === null || value === undefined) delete space(ns)[key];
      else space(ns)[key] = JSON.parse(JSON.stringify(value));
      persist(ns);
      return true;
    },
    delete: (key) => {
      const ns = nsOf(key);
      if (!ns || !(key in space(ns))) return false;
      delete space(ns)[key];
      persist(ns);
      return true;
    },
    keys: (prefix) => {
      const ns = nsOf(prefix);
      return ns ? Object.keys(space(ns)).filter((k) => k.startsWith(prefix)).sort() : [];
    },
  },
  notify: (pid: number, text: string, _kind?: NotifyKind) => {
    const p = byId(pid);
    if (p) Chat.sendToPlayer(p, text);
  },
  ui: {
    menu,
    confirm: async (pid, text, o = {}) => (await menu(pid, { text, options: [{ id: "yes", text: o.yes ?? "Ano" }, { id: "no", text: o.no ?? "Ne" }] })) === "yes",
    prompt: async (pid: number, spec: PromptSpec) => {
      if (!spec.choices?.length) return log("ui.prompt bez voleb potřebuje most"), null;
      const pick = await menu(pid, { text: spec.text, options: spec.choices.slice(0, 8).map((c, i) => ({ id: String(i), text: c })) });
      return pick === null ? null : spec.choices[Number(pick)] ?? null;
    },
  },
  hooks: { set: () => () => {}, reset: () => {}, list: () => ({}) },
};
