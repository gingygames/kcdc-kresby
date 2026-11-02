// Shim mostu pro serverovou část modulu KCDC. Import relativní cestou (esbuild ho přibalí), nebo zkopírovat.
//
//   import { most, configureMostFallback } from "../../../most/shim/most";
//   configureMostFallback({ perms: (p, perm) => CFG.admini.includes(p.nickname) });   // jen pro chod bez mostu
//   if (await most().perms.has(p.id, "loutna.admin")) …
//   await most().storage.set("kresby:vyveska/3", data);
//
// Běží-li resource "most", vrátí jeho API, jinak nativní zálohu: groše a inventář hry, Chat, Dialogue (max 8 voleb),
// úložiště do <server>/data/most-shim/<prostor>.json (serverové skripty KCDC mají require("fs")), práva podle
// configureMostFallback.
//
// Most NENÍ v resourceDependencies modulu: KCDC restartuje se závislostí i všechny moduly, které na ní závisejí
// (i nepovinně), a restart mostu by zastavil server na ~6 s. Pořadí startu při bootu drží `priority` v manifestu
// mostu, a když modul přece naběhne dřív (nebo se most restartuje), shim to dorovná sám:
//   - API se přečte jednou (Exports.get("most", "api")) a drží, dokud most běží. Na resourceStop mostu se zahodí:
//     odkazy na funkce zastaveného resource hází ("The function belongs to a resource that has stopped").
//   - Framework pouští resourceStart (i most:ready) ještě ve stavu Loading, kdy Exports.get hází "is not running".
//     Shim proto po startu mostu zkouší export každých 250 ms (nejvýš 20 s) a až pak ohlásí onMostChange(true).
//   - Během výpadku mostu (restart za běhu) jdou zápisy do úložiště do zálohy a zároveň do deníku (na klíč jen
//     poslední). Po návratu mostu se deník přehraje celý (i zápisy z doby přehrávání) a teprve pak modul most
//     dostane a ozvou se posluchači onMostChange.
//   - Čtení během výpadku: deník, pak kopie toho, co modul v tomto běhu z mostu četl nebo do něj zapsal. Klíč, který
//     modul z mostu neznal, přijde ze souboru zálohy (může být starý) a zápis do něj se do návratu mostu odmítne.
//   - Při zastavení vlastního resource se záloha zapisuje hned při každém zápisu (i v handleru resourceStop modulu).
import type {
  CustomItemDef, InventoryEntry, JsonValue, MenuSpec, MostApi, NotifyKind, PromptSpec,
} from "../src/shared/contract";
import { registerItemType } from "../src/shared/items";

declare const require: ((id: string) => any) | undefined;

const MONEY = "5ef63059-322e-4e1b-abe8-926e100c770e";
const MISSING_MS = 5000; // most neběží: znovu se zeptat nejdřív za 5 s (Exports.get na neběžící resource hází)
const WATCH_MS = 250; // po startu mostu: jak často zkoušet, jestli už jdou číst exporty
const WATCH_FOR_MS = 20000;
let fallbackOpts: {
  perms?: (player: Player, perm: string) => boolean;
  dataDir?: string;
  log?: (m: string) => void;
  /** jméno vlastního resource (jinak první resourceStart, který shim uvidí) */
  resource?: string;
} = {};

/** Jak se má záloha chovat bez mostu (práva, kam ukládat). */
export function configureMostFallback(opts: typeof fallbackOpts) {
  fallbackOpts = { ...fallbackOpts, ...opts };
}

// ------------------------------------------------------------------ napojení na most
let api: MostApi | null = null; // API běžícího mostu pro modul (storage obalené kvůli kopii, viz known)
let stopped = false; // most se zastavil a ještě nenastartoval: nečíst (hází) a nevolat staré odkazy
let replaying = false; // most je zpět, přehrává se deník: modul ještě dostává zálohu (zápisy jdou dál do deníku)
let epoch = 0; // roste se startem i stopem mostu: přehrávání ze staršího běhu mostu skončí
let missingUntil = 0;
let missed = false; // modul už dostal zálohu: až most naběhne, je to změna (onMostChange)
let wasRunning = false; // most v tomto běhu modulu už běžel: výpadek je restart, zápisy do deníku
let watch: ReturnType<typeof setTimeout> | null = null;
let watchUntil = 0;
const listeners = new Set<(running: boolean) => void>();
/** zápisy do úložiště během výpadku mostu: klíč -> hodnota (null = smazat); na klíč jen poslední zápis */
const journal = new Map<string, JsonValue | null>();
const journaling = () => wasRunning && api === null;

// Kopie toho, co modul v tomto běhu přečetl z mostu nebo do něj zapsal (JSON text, null = v mostu není). Během
// výpadku se čte z ní, ne ze souboru zálohy (ten je ze dřívějška). Nejvýš KNOWN_MAX znaků, nejstarší pryč.
const KNOWN_MAX = 32 * 1024 * 1024;
const known = new Map<string, string | null>();
let knownSize = 0;
const touched = new Map<string, number>(); // poslední volání na klíč: pozdě došlé get nepřepíše novější set
let touchSeq = 0;
/** klíče přečtené během výpadku ze souboru zálohy (z mostu je modul neznal): zápis do nich se odmítne */
const stale = new Set<string>();

function remember(key: string, text: string | null | undefined) {
  forgetKnown(key);
  if (text === undefined) return;
  known.set(key, text);
  knownSize += text?.length ?? 0;
  for (const k of known.keys()) {
    if (knownSize <= KNOWN_MAX) break;
    if (k !== key) forgetKnown(k);
  }
}
function forgetKnown(key: string) {
  if (!known.has(key)) return;
  knownSize -= known.get(key)?.length ?? 0;
  known.delete(key);
}
const textOf = (v: unknown): string | null | undefined => {
  if (v === null || v === undefined) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
};
const after = <T>(r: T | Promise<T>, f: (v: T) => void): T | Promise<T> =>
  r && typeof (r as Promise<T>).then === "function" ? (r as Promise<T>).then((v) => (f(v), v)) : (f(r as T), r);

/** storage mostu, které si pamatuje, co modul četl a zapsal (pro čtení během výpadku) */
function wrapStorage(s: MostApi["storage"]): MostApi["storage"] {
  return {
    get: (key) => {
      const t = ++touchSeq;
      touched.set(key, t);
      return after(s.get(key), (v) => void (touched.get(key) === t && remember(key, textOf(v))));
    },
    set: (key, value) => {
      const text = textOf(value);
      touched.set(key, ++touchSeq);
      return after(s.set(key, value), (ok) => void (ok === false ? forgetKnown(key) : remember(key, text)));
    },
    delete: (key) => {
      touched.set(key, ++touchSeq);
      return after(s.delete(key), () => remember(key, null));
    },
    keys: (prefix) => s.keys(prefix),
  };
}

function readApi(): MostApi | null {
  try {
    const a = Exports.get("most", "api") as MostApi | undefined;
    return a && typeof a === "object" ? a : null;
  } catch {
    return null; // neběží, nebo ještě startuje
  }
}

function connected(a: MostApi) {
  stopWatch();
  const change = missed || wasRunning;
  const replay = wasRunning && journal.size > 0;
  wasRunning = true;
  missed = false;
  const expose = () => {
    api = { ...a, storage: wrapStorage(a.storage) };
    stale.clear();
    refusedLogged.clear();
  };
  if (!replay) {
    expose();
    // až po návratu z most(): posluchači smějí volat most() a čekat
    if (change) void Promise.resolve().then(() => api && announce(true));
    return;
  }
  // Deník se přehraje celý dřív, než modul most dostane: zápis hned po návratu by jinak přepsala starší hodnota
  // z deníku a čtení by vrátilo stav před výpadkem. Mezitím modul jede na záloze a píše dál do deníku.
  replaying = true;
  const e = epoch;
  void replayJournal(a, e).then((done) => {
    if (e !== epoch) return;
    replaying = false;
    if (!done) return;
    expose();
    announce(true);
  });
}

function announce(running: boolean) {
  for (const f of [...listeners]) {
    try {
      const r = f(running) as unknown;
      if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).catch((e) => log(`onMostChange: ${e}`));
    } catch (e) {
      log(`onMostChange: ${e}`);
    }
  }
}

/** přehrává deník do mostu, dokud není prázdný (i zápisy z doby přehrávání); false = most mezitím zmizel */
async function replayJournal(a: MostApi, e: number): Promise<boolean> {
  let n = 0;
  let failed = 0;
  while (journal.size) {
    if (e !== epoch) return false;
    const [key, value] = journal.entries().next().value as [string, JsonValue | null];
    journal.delete(key);
    let ok: unknown;
    try {
      ok = value === null ? await a.storage.delete(key) : await a.storage.set(key, value);
    } catch (err) {
      ok = err instanceof Error ? err : new Error(String(err));
    }
    if (e !== epoch) {
      // most se zastavil uprostřed: zápis zopakovat při dalším návratu (novější zápis z deníku má přednost)
      if (!journal.has(key)) journal.set(key, value);
      return false;
    }
    n++;
    if (ok instanceof Error || (ok === false && value !== null)) failed++, forgetKnown(key);
  }
  if (n) log(`most je zpět: ${n} zápisů z výpadku přeneseno do jeho úložiště` + (failed ? `, ${failed} odmítnuto` : ""));
  return true;
}

function stopWatch() {
  if (watch !== null) clearTimeout(watch);
  watch = null;
}
function startWatch() {
  stopWatch();
  watchUntil = Date.now() + WATCH_FOR_MS;
  const tick = () => {
    watch = null;
    if (api || stopped || replaying) return;
    const a = readApi();
    if (a) return connected(a);
    if (Date.now() < watchUntil) watch = setTimeout(tick, WATCH_MS);
  };
  watch = setTimeout(tick, WATCH_MS);
}

/** Běží most? (během přehrávání deníku po návratu ještě ne) */
export function hasMost(): boolean {
  return most() !== fallback;
}

/** API mostu, nebo nativní záloha. */
export function most(): MostApi {
  if (api) return api;
  if (replaying || stopped || Date.now() < missingUntil) return fallback;
  const a = readApi();
  if (a) {
    connected(a);
    return api ?? fallback;
  }
  missed = true;
  missingUntil = Date.now() + MISSING_MS;
  return fallback;
}

/**
 * Posluchač změny mostu: `true`, když most naběhne po modulu nebo se vrátí po restartu (exporty už jdou číst, deník
 * výpadku je přehraný), `false`, když se zastaví. Tady modul znovu zaregistruje to, co most drží jen v paměti
 * (vlastní předměty, posluchače `net`), a když data načetl ze zálohy, načte je znovu z mostu. Vrací odhlášení.
 */
export function onMostChange(f: (running: boolean) => void | Promise<void>): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}

// jméno vlastního resource: první resourceStart, který shim uvidí, je jeho (pouští se hned po vstupním skriptu)
let self: string | null = null;
let selfStopping = false; // vlastní resource se zastavuje: zálohu zapisovat hned (časovače zaniknou s ním)

Events.on("resourceStart", (name: string) => {
  if (self === null && name !== "most") self = name;
  if (name !== "most") return;
  api = null;
  stopped = false;
  replaying = false;
  epoch++;
  missingUntil = 0;
  missed = true; // most startuje po modulu: jakmile půjde přečíst, je to změna
  startWatch();
});
Events.on("most:ready", () => void (!api && !stopped && !replaying && watch === null && startWatch()));
Events.on("resourceStop", (name: string) => {
  if (name === (fallbackOpts.resource ?? self)) selfStopping = true;
  if (name !== "most") return;
  const was = api !== null;
  api = null;
  stopped = true;
  replaying = false;
  epoch++;
  stopWatch();
  if (was) announce(false);
});

// ------------------------------------------------------------------ nativní záloha
const refusedLogged = new Set<string>();
/** zápis během výpadku do klíče, který modul přečetl ze souboru zálohy (z mostu ho neznal) */
function refused(key: string) {
  if (!stale.has(key) || known.has(key)) return false;
  if (!refusedLogged.has(key)) refusedLogged.add(key), log(`${key}: most neběží a modul ho z mostu nečetl, zápis odmítnut (přepsal by data mostu)`);
  return true;
}
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
// při každém set; dávka 50 klíčů = 50 zápisů). Při zastavení kteréhokoli resource se dopíše hned. Když se
// zastavuje vlastní resource, píše se hned každý zápis: handler resourceStop modulu běží až po shimu a časovač
// zanikne s resource.
const WRITE_MS = 1000;
const lastWrite = new Map<string, number>();
const pendingWrite = new Map<string, ReturnType<typeof setTimeout>>();
function persist(ns: string) {
  if (!fs) return;
  if (selfStopping) return writeSpace(ns);
  if (pendingWrite.has(ns)) return;
  const wait = (lastWrite.get(ns) ?? -Infinity) + WRITE_MS - Date.now();
  if (wait <= 0) return writeSpace(ns);
  pendingWrite.set(ns, setTimeout(() => writeSpace(ns), wait));
}
/** Hned zapíše rozepsanou zálohu úložiště (bez mostu) do souborů. */
export function flushFallbackStorage() {
  for (const ns of [...pendingWrite.keys()]) writeSpace(ns);
}
Events.on("resourceStop", () => flushFallbackStorage());
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
  // Během výpadku mostu (už v tomto běhu běžel) se zápisy navíc píšou do deníku. Čtení: deník, pak kopie z mostu
  // (known), a až pak soubor zálohy, který může být ze dřívějška. Klíč přečtený ze souboru je `stale`: zápis do
  // něj by po návratu mostu přepsal jeho data, proto se do návratu mostu odmítne (false).
  storage: {
    get: (key) => {
      if (journaling()) {
        if (journal.has(key)) {
          const j = journal.get(key);
          return j === null || j === undefined ? undefined : JSON.parse(JSON.stringify(j));
        }
        if (known.has(key)) {
          const t = known.get(key);
          return t === null || t === undefined ? undefined : JSON.parse(t);
        }
        stale.add(key);
      }
      const ns = nsOf(key);
      const v = ns ? space(ns)[key] : undefined;
      return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    },
    set: (key, value) => {
      const ns = nsOf(key);
      if (!ns) return false;
      if (journaling()) {
        if (refused(key)) return false;
        const text = textOf(value);
        if (text === undefined) return false;
        journal.set(key, text === null ? null : JSON.parse(text));
        remember(key, text);
      }
      if (value === null || value === undefined) delete space(ns)[key];
      else space(ns)[key] = JSON.parse(JSON.stringify(value));
      persist(ns);
      return true;
    },
    delete: (key) => {
      const ns = nsOf(key);
      if (!ns) return false;
      let had = key in space(ns);
      if (journaling()) {
        if (refused(key)) return false;
        had = known.has(key) ? known.get(key) !== null : had || journal.has(key);
        journal.set(key, null);
        remember(key, null);
      }
      if (key in space(ns)) delete space(ns)[key], persist(ns);
      return had;
    },
    keys: (prefix) => {
      const ns = nsOf(prefix);
      if (!ns) return [];
      const all = new Set(Object.keys(space(ns)).filter((k) => k.startsWith(prefix)));
      if (journaling()) {
        for (const [k, t] of known) if (k.startsWith(prefix)) t === null ? all.delete(k) : all.add(k);
        for (const [k, v] of journal) if (k.startsWith(prefix)) v === null ? all.delete(k) : all.add(k);
      }
      return [...all].sort();
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
