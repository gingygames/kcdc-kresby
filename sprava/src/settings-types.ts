// Nastavení modulů ve Správě: typy API (jen typy, žádný kód, žádné globály KCDC).
// Modul je importuje jen jako typy: import type { SettingsDef } from "../../sprava/src/settings-types";
// nebo si je zkopíruje (stejný postup jako `most/src/shared/contract.ts`). Popis a příklad: sprava/AGENTS.md, oddíl „Nastavení modulů“.
//
//   Exports.get("sprava", "registerSettings")(def: SettingsDef, "<jméno tvého resource>")   // nebo export "spravaSettings"

export type Awaitable<T> = T | Promise<T>;

/** Hodnota nastavení je čisté JSON. Kořen je vždy objekt (`{ klíč: hodnota }`). */
export type SettingsValue = null | boolean | number | string | SettingsValue[] | { [key: string]: SettingsValue };
export type SettingsObject = { [key: string]: SettingsValue };

export interface SettingsOption {
  value: string | number;
  label: string;
  hint?: string;
}

/** Souřadnice ve světě (metry). `yaw` ve stupních: 0 = k +Y, roste doleva (vpřed = (-sin, cos)), jako ve zbytku projektu. */
export interface SettingsPosition {
  x: number;
  y: number;
  z: number;
  yaw?: number;
}

/** Pojmenované místo (snímek z místa ve Správě: tabulky hry, body zájmu, vlastní místa). */
export interface SettingsPlace {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  level: string;
}

/** Hodnota pro porovnání v `showIf`. */
export type ShowIfValue = string | number | boolean | null;

/**
 * Podmíněné zobrazení pole. Skryté pole se neověřuje (žádné chyby „povinné“), jeho hodnota se ale zachová.
 * `field` je cesta k jinému poli: `typ` = sourozenec ve stejném objektu (skupině / položce seznamu), `a.b` = vnořená cesta,
 * `../typ` = o objekt výš (opakovat), `/obecne.rezim` = od kořene. Bez operátoru znamená „je pravdivé“ (`truthy`).
 */
export type ShowIf =
  | {
      field: string;
      eq?: ShowIfValue;
      ne?: ShowIfValue;
      in?: ShowIfValue[];
      nin?: ShowIfValue[];
      gt?: number;
      gte?: number;
      lt?: number;
      lte?: number;
      truthy?: boolean;              // true = pravdivé (výchozí), false = nepravdivé / prázdné
    }
  | { all: ShowIf[] }
  | { any: ShowIf[] }
  | { not: ShowIf };

interface FieldBase {
  /** Jméno v objektu hodnoty. Povinné u polí ve `fields` (kořen, group); u `item` seznamu se nepoužívá. */
  key: string;
  label?: string;
  help?: string;
  /** Prázdná hodnota je chyba (string: ""; number/select/item/place/position: null; list: bez položek). */
  required?: boolean;
  /** U pole se ukáže tlačítko „Test“ a volá se `SettingsDef.preview` s cestou k tomuto poli (hodnota je celý neuložený strom). */
  preview?: boolean;
  /** Zobrazit jen když platí podmínka (viz `ShowIf`). */
  showIf?: ShowIf;
}

export interface StringField extends FieldBase {
  type: "string" | "text";           // text = víceřádkový
  default?: string;
  maxLength?: number;                // string 500, text 4000
  placeholder?: string;
}

export interface NumberField extends FieldBase {
  type: "number";
  default?: number;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  unit?: string;                     // jen popisek („m“, „s“, „gr“)
}

export interface BooleanField extends FieldBase {
  type: "boolean";
  default?: boolean;
}

export interface SelectField extends FieldBase {
  type: "select";
  options: SettingsOption[] | (() => SettingsOption[]);   // funkce se vyhodnotí při každém odeslání schématu a ověření
  default?: string | number;
}

/** Předmět z nativního katalogu hry; hodnota = název z herních tabulek (`bread_wheaten`). */
export interface ItemField extends FieldBase {
  type: "item";
  default?: string;
  /**
   * Jen předměty, které jdou obléct (`Inventory.classes()`, šatník; jen ty bere `Inventory.set` jako oblečené).
   * Bez příznaku platí každý předmět, který server zná (`Inventory.getItemPrice(název) !== null`): jídlo, byliny, šípy, nástroje.
   */
  wearable?: boolean;
  /**
   * Zúžení nabídky na kategorii katalogu předmětů (resource `katalog`): `zbrane`, `strelne`, `obleceni`, `zbroj`, `kun`, `jidlo`, `alchymie`,
   * `dokumenty`, `kostky`, `suroviny`, `ostatni`. Bez běžícího katalogu se ignoruje (hledá se jako dřív v seznamu hry).
   */
  category?: string;
}

/** Pojmenované místo (výběr z míst Správy); hodnota = `SettingsPlace`. UI nabízí i „Teleportovat se sem“. */
export interface PlaceField extends FieldBase {
  type: "place";
  default?: SettingsPlace;
}

/** Souřadnice; UI nabízí „Vzít moji pozici a směr“, „Teleportovat se sem“ a vyplnění z pojmenovaného místa. */
export interface PositionField extends FieldBase {
  type: "position";
  yaw?: boolean;                     // výchozí true: pole směru
  default?: SettingsPosition;
}

/** Barva `"#rrggbb"` (s `alpha: true` i `"#rrggbbaa"`), malými písmeny. */
export interface ColorField extends FieldBase {
  type: "color";
  default?: string;
  alpha?: boolean;
}

/** Číslo s posuvníkem (`min` a `max` jsou povinné). Hodnota = `number`. */
export interface SliderField extends FieldBase {
  type: "slider";
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  unit?: string;
  default?: number;                  // výchozí `min`
  /** Při tažení se (omezeně) volá `SettingsDef.live` s hodnotou pole, bez uložení: živý náhled ve hře. */
  live?: boolean;
}

export interface Vector3Value {
  x: number;
  y: number;
  z: number;
}

/** Trojice čísel (posun, měřítko, barva RGB …). Hodnota = `{ x, y, z }`, nikdy `null`. */
export interface Vector3Field extends FieldBase {
  type: "vector3";
  min?: number;                      // pro každou složku
  max?: number;
  step?: number;
  unit?: string;
  default?: Vector3Value;            // výchozí 0, 0, 0
  live?: boolean;
}

/** Posun a natočení úchytu (věc v ruce, rekvizita): metry a stupně. */
export interface OffsetValue {
  x: number;
  y: number;
  z: number;
  /** natočení ve stupních kolem os, -180..180 */
  rx: number;
  ry: number;
  rz: number;
}

/**
 * Posun (`x y z` v metrech) a natočení (`rx ry rz` ve stupních). Hodnota = `OffsetValue`, nikdy `null`.
 * Pole klade `live: true` tlačítko „Ladit naživo“: pak UI při každé změně (nejvýš 5× za sekundu) volá `SettingsDef.live`,
 * modul hodnotu hned ukáže ve hře (rekvizita v ruce admina) a uloží ji až `set`.
 */
export interface OffsetField extends FieldBase {
  type: "offset";
  /** největší posun v metrech (výchozí 1) */
  range?: number;
  /** krok posunu v metrech (výchozí 0,005) */
  step?: number;
  /** krok natočení ve stupních (výchozí 1) */
  rotStep?: number;
  default?: OffsetValue;
  live?: boolean;
}

/** Odkaz na nahraný soubor. `ref` si u `file` polí vydává Správa (`fs:<nastaveni>/<soubor>`) nebo modul svým `upload`. */
export interface FileRef {
  ref: string;
  name: string;
  size: number;
  kind: "ogg" | "png";
}

/**
 * Nahrání souboru `.ogg` nebo `.png` z počítače admina (po částech, s limitem velikosti).
 * Hodnota = `FileRef | null`. Správa soubor uloží do `data/files/<nastaveni>/` vedle resource (potřebuje `fs`);
 * modul to může převzít vlastním `SettingsDef.upload` (např. do `most.storage` nebo do streamované složky) a vrátit vlastní `ref`.
 * Číst: `Exports.get("sprava", "readFile")(ref)` (bajty) a `filePath(ref)` (cesta k souboru na serveru).
 */
export interface FileField extends FieldBase {
  type: "file";
  accept: ("ogg" | "png")[];
  /** nejvíce bajtů (výchozí 1 MiB, nejvýš 8 MiB) */
  maxBytes?: number;
  default?: null;
}

/**
 * Zvuk: pojmenovaný zvuk hry (trigger, např. `lute_strum`), nebo nahraný soubor (`allowFile`).
 * Hodnota = `string | null`: trigger, nebo `"file:" + FileRef.ref`.
 * Tlačítko „Přehrát na mně“ volá `SettingsDef.play`; bez ní Správa sama zahraje trigger hry na adminovi.
 */
export interface SoundField extends FieldBase {
  type: "sound";
  /** známé zvuky k výběru; hra seznam triggerů nevydává, proto jde psát i vlastní (kromě `strict`) */
  options?: SettingsOption[] | (() => SettingsOption[]);
  strict?: boolean;
  allowFile?: boolean;
  /** nejvíce bajtů nahraného souboru (výchozí 1 MiB) */
  maxBytes?: number;
  default?: string | null;
}

/** Animace: fragment a tagy (hra jich zná přes šest tisíc), případně klip modulu. Hodnota = `AnimationValue | null`. */
export interface AnimationValue {
  fragment: string;
  tags: string;
  /** klip streamovaný modulem (`animations/kcdc/<resource>/x.caf`); pak je `fragment` prázdný */
  clip: string;
  loop: boolean;
}

/** Výběr animace s hledáním v `Animations.list()` a tlačítky „Přehrát na mně“ / „Zastavit“ (volá `SettingsDef.play`, jinak `player.playAnimation`). */
export interface AnimationField extends FieldBase {
  type: "animation";
  /** dovolit klip modulu místo fragmentu */
  clip?: boolean;
  default?: AnimationValue | null;
}

/** Šablona nové položky seznamu („nástroj podle loutny“). */
export interface ListTemplate {
  label: string;
  /** hodnoty položky; doplní se výchozími ze schématu položky */
  value: SettingsObject;
}

export interface ListField extends FieldBase {
  type: "list";
  /** Schéma jedné položky: skalární pole, nebo `group` (objekt). Klíč se nepoužívá. */
  item: DistributiveOmit<SettingsField, "key">;
  default?: SettingsValue[];
  min?: number;
  max?: number;
  /** U položek-skupin: klíč pole, jehož hodnota je nadpis položky („name“). */
  itemLabel?: string;
  /** U položek-skupin: klíč pole, jehož hodnota musí být v seznamu jedinečná („id“). Slouží i k adresaci položky v odkazu (`nastroje.tamburina`). */
  unique?: string;
  addLabel?: string;
  /**
   * Šablony pro „Přidat podle…“. UI vždy nabídne i kopii kterékoli existující položky (duplikace s novým `unique` id).
   * Při přidání z šablony / kopie se admin zeptá na nové id (`unique`) a název (`itemLabel`).
   */
  templates?: ListTemplate[];
}

export interface GroupField extends FieldBase {
  type: "group";
  fields: SettingsField[];
  collapsed?: boolean;               // UI složí skupinu
}

export type SettingsField =
  | StringField
  | NumberField
  | BooleanField
  | SelectField
  | ItemField
  | PlaceField
  | PositionField
  | ColorField
  | SliderField
  | Vector3Field
  | OffsetField
  | FileField
  | SoundField
  | AnimationField
  | ListField
  | GroupField;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type SettingsPath = (string | number)[];

/** Chyba u pole. `path` je tečkový zápis s indexy: `origins.2.name`; prázdný řetězec = celé nastavení. */
export interface SettingsError {
  path: string;
  message: string;
}

export interface SettingsCtx<P = unknown> {
  /** Admin, který nastavení otevřel / ukládá. */
  caller: P;
}

export interface SettingsSetCtx<P = unknown> extends SettingsCtx<P> {
  /** Hodnota před uložením (výsledek posledního `get`). */
  previous: SettingsObject;
}

export interface SettingsPreviewCtx<P = unknown> extends SettingsCtx<P> {
  /** Celý neuložený (ale ověřený) strom z editoru. */
  value: SettingsObject;
  /** Cesta k poli / položce, u které admin stiskl „Test“; `[]` = celé nastavení. */
  path: SettingsPath;
}

/** Návratová hodnota `set` a `reset`: nic / zpráva = uloženo; objekt dovolí odmítnout (`ok: false`, `errors`) nebo opravit hodnotu. */
export type SettingsSetResult =
  | void
  | string
  | {
      ok?: boolean;                  // výchozí true
      message?: string;
      errors?: SettingsError[];      // chyby u polí (modul ví věci, které schéma neumí)
      value?: SettingsObject;        // hodnota, kterou modul skutečně uložil (UI ji načte místo odeslané)
    };

export interface SettingsLiveCtx<P = unknown> extends SettingsCtx<P> {
  phase: "start" | "update" | "end";
  /** cesta pole, které se ladí */
  path: SettingsPath;
  /** aktuální (neuložená, ověřená) hodnota pole; u `end` poslední známá */
  value: SettingsValue | undefined;
  /** celý neuložený strom */
  tree: SettingsObject;
}

export interface SettingsPlayCtx<P = unknown> extends SettingsCtx<P> {
  kind: "sound" | "animation" | "file";
  path: SettingsPath;
  /** hodnota pole (`string` trigger / `"file:<ref>"`, `AnimationValue`, `FileRef`) */
  value: SettingsValue;
  /** `true` = zastavit (tlačítko „Zastavit“) */
  stop?: boolean;
}

export interface SettingsUploadCtx<P = unknown> extends SettingsCtx<P> {
  path: SettingsPath;
  /** čisté jméno souboru (písmena, číslice, `_ . -`) */
  name: string;
  kind: "ogg" | "png";
  size: number;
  bytes: Uint8Array;
}

export interface SettingsPreviewResult {
  ok?: boolean;
  message?: string;
  text?: string;
  info?: { label: string; value: string | number | boolean | null }[];
}

export interface SettingsDef<P = unknown> {
  /** [A-Za-z0-9_.-], jedinečné na serveru (jmenný prostor jako u panelů: `prichod`). */
  id: string;
  title: string;
  description?: string;
  /** Skupina v navigaci; výchozí vlastník (resource). */
  group?: string;
  order?: number;
  /** Oprávnění (zobrazení i ukládání); výchozí `<owner>.admin`. Přes `most.perms.has`, obecné `admin` ho pokrývá. */
  perm?: string;
  /** Strom polí (kořen = objekt). */
  schema: SettingsField[];
  /** Aktuální uložená hodnota. Správa ji ověří podle schématu, doplní výchozí a pošle do UI. */
  get(ctx: SettingsCtx<P>): Awaitable<SettingsObject>;
  /**
   * Uloží a použije nastavení za běhu (bez restartu). Dostane hodnotu, kterou Správa ověřila a normalizovala
   * (neznámé klíče pryč, výchozí doplněné). Modul si data ukládá sám (např. `most.storage`).
   */
  set(value: SettingsObject, ctx: SettingsSetCtx<P>): Awaitable<SettingsSetResult>;
  /**
   * „Obnovit výchozí“. Bez ní Správa zavolá `set` s výchozími hodnotami ze schématu (`default`).
   * S ní modul vrátí nové nastavení (nebo nic: Správa pak načte `get`).
   */
  reset?(ctx: SettingsCtx<P>): Awaitable<void | string | SettingsSetResult>;
  /** „Náhled / test“ neuloženého stavu (ukáže příjezd, přenese admina na místo, …). Nesmí nic ukládat. */
  preview?(ctx: SettingsPreviewCtx<P>): Awaitable<void | string | SettingsPreviewResult>;
  /**
   * „Ladit naživo“ (pole s `live: true`: `slider`, `vector3`, `offset`). Dokud admin ladí, volá UI tuhle funkci (`phase: "update"`,
   * nejvýš 5× za sekundu) s aktuální neuloženou hodnotou pole. Modul ji hned ukáže ve hře (rekvizita v ruce admina, jas, hlasitost …)
   * a NIC neukládá. `phase: "start"` přijde při zapnutí ladění, `"end"` při vypnutí, zavření panelu nebo odpojení admina:
   * modul tehdy vrátí ukázku do uloženého stavu.
   */
  live?(ctx: SettingsLiveCtx<P>): Awaitable<void | string | SettingsPreviewResult>;
  /**
   * „Přehrát na mně“ u polí `sound` a `animation` (a u `file` s `.ogg`). Bez ní Správa zahraje trigger hry / fragment animace
   * na adminovi sama; nahraný soubor bez této funkce přehrát neumí.
   */
  play?(ctx: SettingsPlayCtx<P>): Awaitable<void | string | SettingsPreviewResult>;
  /**
   * Převzetí nahraného souboru (pole `file`, `sound` s `allowFile`). Bez ní ho uloží Správa do `data/files/<nastaveni>/` (potřebuje `fs`).
   * Modul ho může uložit jinam (`most.storage`, streamovaná složka resource) a vrátit vlastní `ref` (`^[a-z]+:[A-Za-z0-9_./:-]{1,200}$`).
   * Velikost a typ (`OggS` / PNG hlavička) Správa ověřila předem.
   */
  upload?(ctx: SettingsUploadCtx<P>): Awaitable<void | { ok?: boolean; message?: string; ref?: string }>;
}

// ---------------------------------------------------------------------------
// Protokol pro UI (klient <-> server), viz AGENTS.md. Jiné UI posílá a poslouchá stejné zprávy.

export type SettingsOp =
  | "get"
  | "validate"
  | "save"
  | "reset"
  | "preview"
  | "here"
  | "goto"
  | "live"
  | "upload"
  | "play"
  | "history"
  | "restore";

/** klient -> server, událost `sprava:settings` */
export interface SettingsReqMsg {
  rid: number;
  id: string;
  op: SettingsOp;
  /** validate, save, preview, live, play: celý strom z editoru */
  value?: SettingsObject;
  /** preview: cesta pole, u kterého byl stisknut „Test“ */
  path?: SettingsPath;
  /** goto: kam se teleportovat */
  position?: SettingsPosition;
  /** live: start | update | end (u `end` je `value` volitelné) */
  phase?: "start" | "update" | "end";
  /** play: pole `path` (sound / animation / file) se přehraje s hodnotou z `value`; `stop: true` zastaví */
  play?: { stop?: boolean };
  /** upload: jedna část souboru (base64, nejvýš 48 000 znaků); `path` je pole `file` / `sound` */
  upload?: { id: string; index: number; total: number; data: string; name: string; size: number };
  /** restore: čas záznamu z `history`, jehož předchozí stav se vrací */
  at?: number;
}

export interface SettingsHistoryItem {
  at: number;
  by: string;
  name: string;
  kind: "save" | "reset" | "restore";
  /** změny, které ten zápis udělal (zkrácené) */
  changes: { path: string; from: string; to: string }[];
  /** kolik hodnot se liší mezi stavem PŘED tímto zápisem a aktuálním stavem (= co by vrácení změnilo) */
  vsNow: number;
}

/** server -> klient, událost `sprava:settingsResult` (odpověď na jednu žádost stejného `rid`) */
export interface SettingsResultMsg {
  rid: number;
  id: string;
  op: SettingsOp;
  ok: boolean;
  message?: string;
  /** get, reset, save (po uložení), validate: ověřená a normalizovaná hodnota */
  value?: SettingsObject;
  /** get, reset: hodnota z výchozích hodnot schématu (pro „výchozí“ porovnání) */
  defaults?: SettingsObject;
  errors?: SettingsError[];
  /** here: pozice a směr admina */
  position?: SettingsPosition;
  /** preview, live, play */
  text?: string;
  info?: { label: string; value: string | number | boolean | null }[];
  /** upload: po poslední části hotový odkaz na soubor; mezi částmi `progress` 0..1 */
  file?: FileRef;
  progress?: number;
  /** history: nejnovější první */
  history?: SettingsHistoryItem[];
}

/** schéma, které dostane UI (funkce vyhodnocené, jen JSON) */
export interface SettingsWire {
  id: string;
  title: string;
  description?: string;
  group: string;
  order: number;
  owner: string;
  schema: SettingsField[];
  canPreview: boolean;
  /** modul umí `live` / `play` */
  canLive: boolean;
  canPlay: boolean;
}
