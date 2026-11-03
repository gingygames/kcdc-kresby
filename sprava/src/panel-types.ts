// Panely modulů ve Správě: typy API (jen typy, žádný kód, žádné globály KCDC, žádné importy).
// Modul si soubor zkopíruje (stejně jako `settings-types.ts` nebo `most/src/shared/contract.ts`), nebo ho importuje jen jako typy:
//   import type { PanelDef } from "../../sprava/src/panel-types";
// Popis a příklad: sprava/AGENTS.md, oddíl 1. Verze smlouvy: Exports.get("sprava", "panelVersion") (1 = tenhle soubor).
//
//   Exports.get("sprava", "registerPanel")(def: PanelDef, "<jméno tvého resource>")   // nebo export "spravaPanels"

export type Awaitable<T> = T | Promise<T>;

export type ParamType = "string" | "text" | "number" | "boolean" | "select" | "player" | "item" | "place";

export interface Option {
  value: string | number;
  label: string;
  hint?: string;
  /** doplňující data k volbě (místa: x, y, z, level) */
  data?: Record<string, string | number>;
}

/**
 * Hráč, jak ho handler dostane v `ctx.caller` a v parametrech typu `player`.
 * Každý resource má od KCDC 1.7.3 vlastní runtime a přes `Exports` jde jen kopie bez prototypu: nativní `Player` by dorazil
 * jako prázdný objekt. Správa proto posílá jen `{ id, nickname }`; cokoli dalšího si modul vezme přes `Player.getById(ref.id)`.
 */
export interface PlayerRef {
  id: number;
  nickname: string;
}

export interface ParamDef {
  name: string;
  label?: string;
  type?: ParamType;                      // výchozí "string"
  required?: boolean;                    // výchozí true (kromě boolean a parametrů s výchozí hodnotou)
  default?: string | number | boolean;   // u "player" lze "me" = ten, kdo akci spouští
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  options?: Option[] | (() => Option[]); // pro "select"
  placeholder?: string;
  help?: string;
  maxLength?: number;
  /** type "item": jen předměty, které jdou obléct (Inventory.classes()); jinak každý, který server zná */
  wearable?: boolean;
  /** type "item": kategorie katalogu předmětů (resource `katalog`) */
  category?: string;
}

export interface ActionContext<P = PlayerRef> {
  caller: P;                             // admin, který akci spustil: { id, nickname } (viz PlayerRef)
  /** hodnoty podle typů: player -> { id, nickname }, place -> {id, name, x, y, z, level}, item -> id předmětu, ostatní prostě hodnota */
  params: Record<string, any>;
  panel: string;
  action: string;
}

export type Cell = string | number | boolean | null;

export interface TableColumn {
  key: string;
  label: string;
  align?: "right" | "center";
}

/** tlačítko u řádku tabulky: spustí akci a parametry vezme ze sloupců řádku */
export interface RowAction {
  action: string;
  label: string;
  params?: Record<string, string>;   // jméno parametru -> klíč sloupce
  fixed?: Record<string, Cell>;      // pevné hodnoty parametrů
  confirm?: string;
  danger?: boolean;
  when?: string;                     // jen když je sloupec pravdivý
  whenNot?: string;                  // jen když je sloupec nepravdivý
}

export interface Table {
  columns: TableColumn[];
  rows: Record<string, Cell>[];      // sloupce začínající "_" se nezobrazují (identifikátory pro řádkové akce)
  rowActions?: RowAction[];
  empty?: string;
}

export interface ActionResult {
  ok?: boolean;                          // výchozí true
  message?: string;
  text?: string;                         // předformátovaný blok (výpis logu)
  table?: Table;
  info?: { label: string; value: Cell }[];
  close?: boolean;                       // zavřít panel po akci
}

export type Handler<P = PlayerRef> = (ctx: ActionContext<P>) => Awaitable<string | void | null | undefined | ActionResult>;

export interface ActionDef<P = PlayerRef> {
  id: string;
  label: string;
  description?: string;
  perm?: string;                         // výchozí oprávnění panelu
  confirm?: string | boolean;
  danger?: boolean;
  autorun?: boolean;
  every?: number;
  submit?: string;
  params?: ParamDef[];
  handler: Handler<P>;
}

export interface PanelDef<P = PlayerRef> {
  id: string;
  title: string;
  group?: string;                        // výchozí = vlastník (modul), vestavěné panely "Správa"
  order?: number;
  description?: string;
  perm?: string;                         // výchozí `<owner>.admin` (kresby.moderate, loutna.admin … podle smlouvy mostu)
  owner?: string;                        // jméno resource; při jeho zastavení panel zmizí. Výchozí: id panelu
  actions: ActionDef<P>[];
  /**
   * Tvar panelu: `"ctx"` (výchozí, handler dostane `ActionContext`) nebo `"legacy"` (starší tvar: parametry s `id` místo `name`,
   * `handler(admin, params)`, hodnoty `player` jako číslo). Bez příznaku Správa starší tvar pozná jen podle parametrů s `id`
   * a zapíše do logu, že je zastaralý.
   */
  compat?: "ctx" | "legacy";
  /** jen pro `compat: "legacy"`: `"id"` = první argument handleru je číslo (id admina), jinak `{ id, nickname }` */
  callerAs?: "ref" | "id";
}
