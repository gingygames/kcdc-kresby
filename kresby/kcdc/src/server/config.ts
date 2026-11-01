// Nastavení kreseb pro server KCDC: výchozí hodnoty + globalThis.KRESBY_CONFIG z kresby_config.js (načte se před server.js).

import type { RGB } from "../shared/ink";

export interface Recipe {
  id: string; // část id předmětu kresby:inkoust:<id>
  name: string;
  rgb: RGB;
  flags: number;
  strength: number;
  drops: number;
  needs: [string, number][]; // herní předměty (jména z tabulek hry) a počet; navíc vždy 1 prázdná lahvička
  about: string;
}

export interface ShopRow {
  kind: "sheet" | "book" | "ink" | "plain";
  paper?: number;
  recipe?: string; // id receptu
  item?: string; // herní předmět
  name?: string;
  price: number;
}

/** stejné názvy jako most.storage (kontrakt mostu, MostStorage): klíče "kresby:<cokoli>", hodnoty JSON */
/** druh listu (materiál): kód je trvalý v datech kresby, 0 = pergamen, 1 = papír */
export interface Paper {
  kod: number;
  id: string; // část id předmětu (kód 0 a 1 mají historická id kresby:pergamen / kresby:papir)
  name: string;
  popis: string;
  barva: string; // "#rrggbb" podklad textury
  styl: "pergamen" | "papir" | "hladky";
  cena: number;
  vaha: number;
}

export interface Michani {
  pomery: [number, number][];
  mnozstvi: number[]; // kapek směsi k výběru
  vodaPridava: number; // ředění: přidá tento podíl kapek (0.5 = polovina)
  minSytost: number;
}

export interface Nastroj {
  nazev: string;
  zapnuto: boolean;
  predmet: string; // herní předmět, který hráč musí mít ("" = vždy)
}

export interface Storage {
  get(key: string): unknown | Promise<unknown>;
  set(key: string, value: unknown): unknown | Promise<unknown>;
  delete?(key: string): unknown | Promise<unknown>;
  keys?(prefix: string): string[] | Promise<string[]>;
}

export interface Config {
  command: string;
  // kdo je správce / moderátor, když chybí resource most (most.perms.has)
  admini: string[];
  isAdmin: ((p: Player) => boolean) | null;
  // id a jméno postavy, když chybí most (most.identity)
  identity: ((p: Player) => { id: string; name: string }) | null;
  // úložiště, když chybí most.storage; null = jen v paměti (desky po restartu zmizí, kresby v brašnách zůstanou)
  storage: Storage | null;

  maxPoints: number; // bodů na kresbu
  maxStrokes: number;
  batchStrokes: number; // tahů v jedné dávce od klienta
  batchPoints: number;
  cooldownMs: number; // jedna uložená kresba za tolik ms na postavu
  maxInks: number; // kolik inkoustů z brašny jde do jedné kresby
  tearDown: "anyone" | "author" | "admin"; // kdo smí strhnout list z vývěsky
  useRange: number; // jak blízko desky musí hráč stát (m)
  liveRange: number; // do kolika m hráči vidí cizí kreslení naživo
  streamRange: number; // do kolika m klient o desce ví (data kreseb si stahuje až zblízka, viz klient)
  streamMs: number; // jak často server přepočítá desky v okolí hráčů
  idleMs: number; // kreslení bez tahu se po tolika ms zahodí
  maxBoards: number;
  maxSlots: number; // listů na jedné vývěsce
  itemDataMax: number; // kresba do dat předmětu, je-li zakódovaná kratší (limit KCDC 16 KiB JSON na vlastnosti)
  dataRate: number; // B/s dat kreseb na hráče
  cacheBytes: number; // mezipaměť kreseb na serveru
  saveMs: number; // zápisy do úložiště se slučují

  materials: {
    sheetVisual: string;
    bookVisual: string;
    inkVisual: string;
    drawingVisual: string;
    vialItem: string;
    waterItems: string[];
    nativeInk: string; // herní inkoust z kořisti -> lahvička inkoustu
    nativeInkDrops: number;
    dropArea: number; // logických px² tahu (při plném krytí) na 1 kapku
    charcoalArea: number; // px² na 1 kus uhlu
    maxDrops: number;
    inkWeight: number;
    sheetWeight: number;
  };
  papiry: Paper[];
  michani: Michani;
  nastroje: { pen: Nastroj; brush: Nastroj; charcoal: Nastroj; scrape: Nastroj };
  velikost: { min: number; max: number }; // štětec v px listu (0,5 .. 40)
  recipes: Recipe[];
  ingredientNames: Record<string, string>;
  shop: ShopRow[];
  kram: "nativni" | "menu";
  pisar: string; // jméno obchodu písaře // nativni = obchod hry (Vendor, groše hry); menu = nabídka + most.economy
  stojan: { model: string | null; up: number; forward: number; tilt: number; width: number; yaw: number };
  // kresby ve světě: textura na modelu listu (server/assets.ts, server/props.ts)
  svet: {
    rezim: "textura" | "cary" | "oboji"; // textura = osvětlený list se stíny; cary = ladicí 3D čáry (Gizmos)
    sirka: number; // šířka textury kresby v px (výška = polovina): 512, 1024, 2048
    kvalita: number; // převzorkování rastru (1 = rychle, 2 = hladší čáry)
    shard: number; // kolik kreseb v jednom balíčku assetů (po nové kresbě se stahuje jen ten balíček)
    predpona: string; // jméno balíčků assetů: <predpona>-<n>
    slozka: string; // složka resources serveru (relativně ke složce serveru)
    reloadMs: number; // nejkratší rozestup přenačtení balíčků
    konzole: boolean; // smí kresby přenačíst balíček přes konzoli playgroundu (logs/playground.pid)
    reload: ((novych: string[], zmenenych: string[]) => unknown) | null; // vlastní hák serveru (restart resource)
    odsazeni: number; // list před lícem desky (m)
    rozpocetMs: number; // kolik ms z jednoho kroku smí vzít vykreslování
    lesk: number; // Shininess materiálu (0..255)
  };
  // moderace
  moderace: {
    zakazanaSlova: string[]; // v názvu kresby: kresba se neuloží
    maxVystavenych: number; // kolik kreseb smí mít jedna postava vystavených (0 = bez omezení)
  };
  // klient (posílá se hráčům v první zprávě EV.okoli)
  klient: {
    platno: "auto" | "nativni" | "web"; // kreslicí plátno: Scaleform, HTML (CEF), nebo zkusit Scaleform a pak HTML
    gizmoUnits: number; // z 16 384 sdílených všemi resources
    gizmoIds: number; // ze 128 na resource
    drawRange: number; // do kolika m se kresby kreslí čarami
    paperRange: number; // do kolika m se ukazuje aspoň list (bez kresby)
    cacheBytes: number; // mezipaměť kreseb v klientu
    useKey: string; // klávesa pro desku (vedle nápovědy akce)
  };
}

declare const KRESBY_CONFIG: Partial<Config> | undefined;

export const DEFAULTS: Config = {
  command: "kresby",
  admini: [],
  isAdmin: null,
  identity: null,
  storage: null,
  maxPoints: 15000,
  maxStrokes: 2000,
  batchStrokes: 40,
  batchPoints: 3000,
  cooldownMs: 60000,
  maxInks: 12,
  tearDown: "anyone",
  useRange: 3.5,
  liveRange: 35,
  streamRange: 60,
  streamMs: 1000,
  idleMs: 600000,
  maxBoards: 500,
  maxSlots: 24,
  itemDataMax: 15000,
  dataRate: 262144,
  cacheBytes: 32 * 1024 * 1024,
  saveMs: 2000,
  materials: {
    sheetVisual: "nakaza_dirtyPageFromCrypt",
    bookVisual: "poustevnik_oldOrderPaperAmbroz",
    inkVisual: "loot_oakGallInk",
    drawingVisual: "artefakt_BavorCoatofArmsDrawing",
    vialItem: "pracharna_emptyPotionBottle",
    waterItems: ["alchemyWater", "water"],
    nativeInk: "loot_oakGallInk",
    nativeInkDrops: 30,
    dropArea: 2500,
    charcoalArea: 60000,
    maxDrops: 60,
    inkWeight: 0.25,
    sheetWeight: 0.02,
  },
  papiry: [
    { kod: 0, id: "pergamen", name: "Čistý pergamen", popis: "Vyhlazená telecí kůže, připravená ke kreslení i psaní. Kreslí se na něj u vývěsky nebo stojanu.", barva: "#e8dabc", styl: "pergamen", cena: 3, vaha: 0.02 },
    { kod: 1, id: "papir", name: "Arch papíru", popis: "Arch ručního papíru s žebrováním. Kreslí se na něj u vývěsky nebo stojanu.", barva: "#f1ecde", styl: "papir", cena: 2, vaha: 0.02 },
  ],
  michani: { pomery: [[3, 1], [2, 1], [1, 1], [1, 2], [1, 3]], mnozstvi: [10, 20, 40], vodaPridava: 0.5, minSytost: 40 },
  nastroje: {
    pen: { nazev: "Brk", zapnuto: true, predmet: "loot_gooseFeathers" },
    brush: { nazev: "Štětec", zapnuto: true, predmet: "malir_paintbrushes" },
    charcoal: { nazev: "Uhel", zapnuto: true, predmet: "special_charcoal" },
    scrape: { nazev: "Škrabka", zapnuto: true, predmet: "" },
  },
  velikost: { min: 0.5, max: 40 },
  recipes: [
    { id: "dubenka", name: "Duběnkový inkoust", rgb: [38, 30, 28], flags: 0, strength: 245, drops: 40,
      needs: [["special_bilin", 1], ["bsmt_ironBad", 1], ["alchemyWine", 1]], about: "duběnky, železo a víno - černý inkoust písařů, časem zhnědne" },
    { id: "saze", name: "Sazový inkoust", rgb: [22, 22, 24], flags: 0, strength: 255, drops: 40,
      needs: [["special_charcoal", 2], ["special_olibanum", 1], ["alchemyWater", 1]], about: "saze z uhlí, pryskyřice jako pojivo a voda - hluboká čerň" },
    { id: "trezalka", name: "Třezalková červeň", rgb: [150, 38, 30], flags: 0, strength: 230, drops: 30,
      needs: [["herb_hypericum", 3], ["alchemyOil", 1]], about: "třezalka vyluhovaná v oleji" },
    { id: "mesicek", name: "Měsíčková žluť", rgb: [205, 160, 40], flags: 0, strength: 225, drops: 30,
      needs: [["herb_marigold", 3], ["alchemyWater", 1]], about: "odvar z měsíčku" },
    { id: "medenka", name: "Měděnka", rgb: [62, 122, 92], flags: 1, strength: 235, drops: 40,
      needs: [["bsmt_copper", 1], ["alchemyWine", 1]], about: "měď naložená ve víně - krycí zelená" },
    { id: "modr", name: "Měděná modř", rgb: [50, 85, 150], flags: 0, strength: 235, drops: 40,
      needs: [["bsmt_copper", 1], ["special_saltpeter", 1], ["alchemyWater", 1]], about: "měď a ledek - modrá jako azurit" },
    { id: "kopriva", name: "Kopřivová zeleň", rgb: [86, 112, 52], flags: 0, strength: 220, drops: 30,
      needs: [["herb_urticaria", 4], ["alchemyWater", 1]], about: "kopřivy" },
    { id: "bez", name: "Bezový purpur", rgb: [96, 42, 86], flags: 0, strength: 225, drops: 30,
      needs: [["herb_elderberrry", 3], ["alchemyWine", 1]], about: "bezové listí ve víně" },
    { id: "asfalt", name: "Asfaltová hněď", rgb: [96, 62, 34], flags: 0, strength: 240, drops: 40,
      needs: [["bsmt_syrianAsfalt", 1], ["alchemyOil", 1]], about: "skalní smola v oleji - hnědá na stíny" },
    { id: "beloba", name: "Kostní běloba", rgb: [236, 230, 214], flags: 1, strength: 255, drops: 30,
      needs: [["special_attire", 1], ["alchemyWater", 1]], about: "drcený paroh - krycí bílá na světla" },
    { id: "zlato", name: "Zlatý inkoust", rgb: [212, 170, 60], flags: 3, strength: 255, drops: 15,
      needs: [["bsmt_redGold", 1], ["special_olibanum", 1]], about: "zlato s pryskyřicí - na iniciály a svatozáře" },
  ],
  ingredientNames: {
    special_bilin: "duběnka", bsmt_ironBad: "kus železa", alchemyWine: "víno (alchymie)",
    special_charcoal: "uhel", special_olibanum: "kadidlo", alchemyWater: "voda (alchymie)",
    herb_hypericum: "třezalka", alchemyOil: "olej (alchymie)", herb_marigold: "měsíček",
    bsmt_copper: "měď", special_saltpeter: "ledek", herb_urticaria: "kopřiva",
    herb_elderberrry: "bezové listí", bsmt_syrianAsfalt: "skalní smola", special_attire: "úlomky parohu",
    bsmt_redGold: "barevné zlato",
  },
  shop: [
    { kind: "sheet", paper: 0, price: 3 },
    { kind: "sheet", paper: 1, price: 2 },
    { kind: "plain", item: "loot_gooseFeathers", name: "Husí brky", price: 2 },
    { kind: "plain", item: "malir_paintbrushes", name: "Sada štětců", price: 15 },
    { kind: "plain", item: "special_charcoal", name: "Uhel", price: 1 },
    { kind: "plain", item: "pracharna_emptyPotionBottle", name: "Prázdná lahvička", price: 1 },
    { kind: "ink", recipe: "dubenka", price: 8 },
    { kind: "book", price: 40 },
  ],
  kram: "nativni",
  pisar: "Písař",
  // model z shared/stojany.ts má natočení a polohu líce změřené z geometrie (up/forward/tilt/yaw tady platí jen pro jiné modely)
  stojan: { model: "objects/manmade/common_decorations/streets_deco/sign_wall_board_rustic.cgf", up: 1.3, forward: 0.06, tilt: 12, width: 1.05, yaw: 0 },
  svet: {
    rezim: "textura",
    sirka: 1024,
    kvalita: 2,
    shard: 24,
    predpona: "kresby-obrazy",
    slozka: "resources",
    reloadMs: 30000,
    konzole: true,
    reload: null,
    odsazeni: 0.004,
    rozpocetMs: 6,
    lesk: 30,
  },
  moderace: { zakazanaSlova: [], maxVystavenych: 0 },
  klient: {
    platno: "auto",
    gizmoUnits: 6000,
    gizmoIds: 96,
    drawRange: 14,
    paperRange: 40,
    cacheBytes: 8 * 1024 * 1024,
    useKey: "f",
  },
};

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over)) return (over ?? base) as T;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over as object)) {
    const b = (base as any)?.[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) && typeof v === "object" && v && !Array.isArray(v) ? merge(b, v) : v;
  }
  return out;
}

export const CFG: Config = merge(DEFAULTS, typeof KRESBY_CONFIG !== "undefined" ? KRESBY_CONFIG : undefined);

/** pro testy a /kresby nastaveni: nastavení za běhu */
export function reconfigure(over: Partial<Config>) {
  Object.assign(CFG, merge(CFG, over));
}
