// Kontrakt resource "most" (verze kontraktu 1). Popis v most/CONTRACT.md – tento soubor je jeho přesná podoba.
// Moduly ho importují jen jako typy: import type { MostApi } from "../../most/src/shared/contract";

export const CONTRACT_VERSION = 1;

/** Hodnota hned, nebo Promise. Volající vždy píše `await` – adaptér frameworku smí odpovídat asynchronně. */
export type Awaitable<T> = T | Promise<T>;
/** Síťové id hráče (`player.id`), platí jen po dobu připojení. */
export type PlayerId = number;
/** Trvalé id postavy. Ve standalone `steam:<id>`, `discord:<id>`, `epic:<id>` nebo `nick:<přezdívka>`; framework má svoje. */
export type CharId = string;

export type NotifyKind = "info" | "success" | "warning" | "error" | "hint";

export interface MostInfo {
  contract: number;
  version: string;
  adapter: string;
  /** Háčky přepsané za běhu (hooks.set) a kým. */
  overrides: Record<string, string>;
}

export interface MostIdentity {
  /** Trvalé id postavy hráče, null když hráč není připojený nebo ještě nemá postavu (framework ji vybírá). */
  getCharacterId(playerId: PlayerId): Awaitable<CharId | null>;
  /** Jméno postavy pro texty (RP jméno ve frameworku, ve standalone přezdívka). */
  getName(playerId: PlayerId): Awaitable<string | null>;
  /** Opačný směr: připojený hráč s touto postavou, jinak null. */
  getPlayerId(charId: CharId): Awaitable<PlayerId | null>;
}

export interface MostPerms {
  /**
   * Má hráč právo? Práva jsou tečkovaná: udělené `admin` zahrnuje `admin.items`, `*` zahrnuje vše.
   * Názvy používané moduly: `admin`, `admin.items`, `admin.money`, `admin.perms`, `kresby.moderate`, `loutna.admin`, `prichod.admin`, `hospoda.admin`.
   */
  has(playerId: PlayerId, perm: string): Awaitable<boolean>;
}

export interface CurrencyInfo {
  id: string;
  label: string;
  /** true = herní groše (předmět `money` v inventáři), jinak měna vedená v mostu/frameworku. */
  native: boolean;
}

export interface MostEconomy {
  /** Výchozí měna (`groschen` = nativní groše KCD2). */
  readonly defaultCurrency: string;
  currencies(): Awaitable<CurrencyInfo[]>;
  getBalance(charId: CharId, currency?: string): Awaitable<number>;
  canAfford(charId: CharId, amount: number, currency?: string): Awaitable<boolean>;
  /** Přičte. false = neznámá měna/postava, záporná částka, nebo framework odmítl. */
  add(charId: CharId, amount: number, currency?: string, reason?: string): Awaitable<boolean>;
  /** Odečte celé, nebo nic. false = nemá dost (nebo jako u add). */
  remove(charId: CharId, amount: number, currency?: string, reason?: string): Awaitable<boolean>;
}

/**
 * Vlastní předmět = nativní předmět KCD2 jako základ + vlastní název, popis a vlastnosti. Bez addonů, na každém serveru.
 * Standalone (ověřeno na KCDC 1.7.1): `Items.register` se vzhledem `visual ?? base`, který musí být drobnost (MiscItem),
 * materiál (CraftingMaterial) nebo dokument (Document) hry. Jiný základ (jídlo, zbraň, oblečení) KCDC přejmenovat
 * nedovolí (metadata.custom na nativní třídě = invalidMetadata): pak se dává obyčejný `base` a zaloguje se to.
 */
export interface CustomItemDef {
  /** Jmenný prostor modulu: `kresby:obraz`, `hospoda:dzban_medoviny`. */
  id: string;
  /** Nativní předmět (jméno z herních tabulek nebo GUID): vzhled, když chybí `visual`, a záloha, když ho KCDC nebere. */
  base: string;
  name: string;
  description?: string;
  /** Vlastnosti modulu (zůstávají na serveru). Jednotlivý kus je může mít jiné (give(..., data)). */
  data?: Record<string, unknown>;
  /** Vzhled pro Items.register (MiscItem/CraftingMaterial/Document: jméno z tabulek nebo GUID). Výchozí = base. */
  visual?: string;
  /** KCDC 1.7.2+: vlastní model, cesta relativní k Objects/ (bez "objects/"), např.
   *  `manmade/task_specific_props/entertainment/music/tambourine.cgf`. S `icon` a bez `visual` = celý vzhled vlastní;
   *  s `visual` = ikona z visual, model vlastní. Starší server ho nezná: most pak registruje jen s visual ?? base. */
  model?: string;
  /** KCDC 1.7.2+: materiál k `model` (bez modelu se nepošle). */
  material?: string;
  /** KCDC 1.7.2+: ikona v inventáři, base64 PNG do 256 KiB. */
  icon?: string;
  weight?: number;
  price?: number;
  stackable?: boolean;
  usable?: boolean;
  useLabel?: string;
}

export interface InventoryEntry {
  /** id řádku inventáře (KCDC). */
  row: string;
  /** GUID třídy předmětu. */
  item: string;
  /** Jméno z herních tabulek (nebo id z Items.register). */
  name: string;
  /** id vlastního předmětu mostu, je-li to on. */
  custom: string | null;
  amount: number;
  label: string | null;
  data: Record<string, unknown> | null;
}

export interface MostInventory {
  /** itemId = jméno z herních tabulek, GUID, nebo id vlastního předmětu (registerCustomItem). */
  has(playerId: PlayerId, itemId: string, count?: number): Awaitable<boolean>;
  count(playerId: PlayerId, itemId: string): Awaitable<number>;
  /** Dá předmět. `data` = vlastnosti kusu: `quality` (1..max), `condition` (0–1) nebo `health` jdou do nativních
   *  vlastností (i u nativních předmětů), zbytek jen u vlastních předmětů do metadata.custom.data (sloučí se s def.data). */
  give(playerId: PlayerId, itemId: string, count?: number, data?: Record<string, unknown>): Awaitable<boolean>;
  /** Vezme celé množství, nebo nic. */
  take(playerId: PlayerId, itemId: string, count?: number): Awaitable<boolean>;
  list(playerId: PlayerId): Awaitable<InventoryEntry[]>;
  registerCustomItem(def: CustomItemDef): Awaitable<boolean>;
  getCustomItem(id: string): CustomItemDef | null;
}

export interface MenuOption {
  id: string;
  text: string;
  enabled?: boolean;
}
export interface MenuSpec {
  title?: string;
  text?: string;
  options: MenuOption[];
  /** Nativně: seznam vpravo místo vlevo. */
  onRight?: boolean;
}
export interface ConfirmOptions {
  yes?: string;
  no?: string;
}
export interface PromptSpec {
  text: string;
  /** Nabídnuté odpovědi (nativně jako dialog + „Napsat vlastní…“). */
  choices?: string[];
  placeholder?: string;
  /** Výchozí 120 s, pak null. */
  timeoutMs?: number;
}

export interface MostUi {
  /** Vrátí id zvolené volby, null = zavřeno/zrušeno. Nativně: herní dialog (Dialogue), po 7 volbách stránkuje. */
  menu(playerId: PlayerId, spec: MenuSpec): Promise<string | null>;
  confirm(playerId: PlayerId, text: string, opts?: ConfirmOptions): Promise<boolean>;
  /** Text od hráče, null = zrušeno/vypršelo. Nativně: hráč napíše `/o <text>` do chatu. */
  prompt(playerId: PlayerId, spec: PromptSpec): Promise<string | null>;
}

/** JSON hodnota úložiště. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/**
 * Úložiště klíč–hodnota pro data modulů (vývěsky, vystavené kresby, nastavení …).
 * Klíč = `<jméno resource>:<cokoli>`, např. `kresby:vyveska/12`. Část před první dvojtečkou je jmenný prostor
 * (standalone: soubor data/most/kv/<prostor>.json). Klíč bez dvojtečky se odmítne.
 * Hodnota musí jít do JSON (uloží se kopie, get vrací kopii). set(key, null) = delete.
 */
export interface MostStorage {
  get(key: string): Awaitable<JsonValue | undefined>;
  /** false = neplatný klíč nebo hodnota (ne-JSON), nebo framework odmítl. */
  set(key: string, value: JsonValue): Awaitable<boolean>;
  delete(key: string): Awaitable<boolean>;
  /** Klíče začínající prefixem (prefix musí obsahovat jmenný prostor, např. `kresby:` nebo `kresby:vyveska/`). Seřazené. */
  keys(prefix: string): Awaitable<string[]>;
}

/** Názvy háčků. Každá metoda API je háček: výchozí z adaptéru, za běhu přepsatelný (hooks.set). */
export type HookName =
  | "identity.getCharacterId" | "identity.getName" | "identity.getPlayerId"
  | "perms.has"
  | "economy.currencies" | "economy.getBalance" | "economy.canAfford" | "economy.add" | "economy.remove"
  | "inventory.has" | "inventory.count" | "inventory.give" | "inventory.take" | "inventory.list" | "inventory.registerCustomItem"
  | "storage.get" | "storage.set" | "storage.delete" | "storage.keys"
  | "notify"
  | "ui.menu" | "ui.confirm" | "ui.prompt";

export interface MostHooks {
  /** Přepíše háček. `owner` = jméno resource; když se zastaví, háček se sám vrátí. Vrací funkci pro vrácení. */
  set(name: HookName, impl: (...args: any[]) => unknown, owner?: string): () => void;
  reset(name: HookName): void;
  list(): Record<string, string>;
}

export interface MostApi {
  info(): MostInfo;
  identity: MostIdentity;
  perms: MostPerms;
  economy: MostEconomy;
  inventory: MostInventory;
  storage: MostStorage;
  notify(playerId: PlayerId, text: string, kind?: NotifyKind): Awaitable<void>;
  ui: MostUi;
  hooks: MostHooks;
}

// ---- události na serverové sběrnici (Events.on("most:…", (e) => …)) ----
export const EVENTS = {
  ready: "most:ready",
  playerReady: "most:playerReady",
  playerLeft: "most:playerLeft",
  moneyChanged: "most:moneyChanged",
  itemChanged: "most:itemChanged",
  permsChanged: "most:permsChanged",
  hooksChanged: "most:hooksChanged",
} as const;

export interface ReadyEvent extends MostInfo {}
export interface PlayerEvent { playerId: PlayerId; charId: CharId | null; name: string | null }
export interface MoneyChangedEvent { charId: CharId; playerId: PlayerId | null; currency: string; balance: number; delta: number; reason: string }
export interface ItemChangedEvent { playerId: PlayerId; charId: CharId | null; item: string; name: string; custom: string | null; delta: number; reason: string }
export interface PermsChangedEvent { charId: CharId | null }
export interface HooksChangedEvent { name: string; owner: string | null }

// ---- klient ----
/** Ovládací prvek modulu. Výchozí backend = Key.bind; framework ho může předělat (radiální menu, vlastní klávesy …). */
export interface ControlSpec {
  /** `modul.akce`, např. `loutna.menu`. */
  id: string;
  /** Výchozí klávesa (jména jako Key.bind). Server ji může přemapovat (most_config.controls). */
  key?: string;
  label: string;
  /** Kdo ho registroval (jméno resource) – při jeho stopu se odregistruje. */
  owner?: string;
  run: () => void;
}
export interface ControlsBackend {
  bind(control: ControlSpec & { key: string | undefined }): void;
  unbind(control: ControlSpec & { key: string | undefined }): void;
}
export interface MostControls {
  register(spec: ControlSpec): () => void;
  list(): { id: string; key: string | undefined; label: string; owner: string | undefined }[];
  trigger(id: string): boolean;
  /** Framework převezme ovládání; null = zpět na Key.bind. */
  setBackend(backend: ControlsBackend | null): void;
}
export interface NotifyRenderer {
  (text: string, kind: NotifyKind, durationMs: number): void;
}
export interface MostClientUi {
  /** Framework převezme zobrazování oznámení; null = zpět na nativní HUD. */
  setNotifyRenderer(renderer: NotifyRenderer | null): void;
  notify(text: string, kind?: NotifyKind, durationMs?: number): void;
}
export interface MostClientApi {
  controls: MostControls;
  ui: MostClientUi;
}

// ---- síť: zprávy bez limitu paketu KCDC (export "net" na serveru i na klientu)

export type NetServerHandler = (player: Player, msg: unknown) => unknown;
export type NetClientHandler = (msg: unknown) => void;
/** `direct: false` = handler dostane jen zprávy složené z částí; malé zprávy pod vlastním jménem si modul poslouchá sám (Events.on) */
export interface NetOnOptions {
  direct?: boolean;
}

/**
 * Server: `Exports.get("most", "net")`. Zpráva nad `limit` znaků JSON jde po částech `most:part`, menší jako obyčejná událost
 * s JSON řetězcem. Handlery přes `on` dostanou složený a rozparsovaný objekt; stejnou událost pak neposlouchej i přes `Events.onClient`.
 */
export interface MostNetServer {
  /** hranice dělení (znaků JSON) */
  readonly limit: number;
  /** zpráva hráči (Player nebo player.id); false = hráč není připojený */
  send(player: Player | number, event: string, msg: unknown): boolean;
  sendAll(event: string, msg: unknown): void;
  /** handler zpráv od klientů; `owner` = jméno resource (při jeho stopu se handler odebere). Vrací funkci pro odregistrování */
  on(event: string, fn: NetServerHandler, owner?: string, opts?: NetOnOptions): () => void;
}

/** Klient: `Exports.get("most", "net")`, protějšek MostNetServer. */
export interface MostNetClient {
  readonly limit: number;
  emitServer(event: string, msg: unknown): void;
  on(event: string, fn: NetClientHandler, owner?: string, opts?: NetOnOptions): () => void;
}
