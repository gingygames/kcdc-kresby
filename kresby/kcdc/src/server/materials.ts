// Materiál ke kreslení na KCDC: vlastní předměty (Items.register = herní předmět jako vzhled + vlastní název, popis
// a data na serveru), recepty, míchání, ředění, kniha o barvách a krám písaře.
//
// Na rozdíl od KCD:MP tu není databáze předmětů: kapky, barva a sytost lahvičky jsou v datech jejího řádku
// v inventáři (metadata.custom.data), takže putují s lahvičkou do truhly, k jinému hráči i přes obchod.
//
//   kresby:pergamen, kresby:papir   čistý list (skládá se), vzhled dokumentu
//   kresby:kniha                    Kniha o barvách a inkoustech (použít = dílna, číst = nativní kniha hry)
//   kresby:inkoust:<recept>         lahvička inkoustu podle receptu (vlastní typ, aby ji krám mohl prodávat)
//   kresby:inkoust                  smíchaný inkoust
//   kresby:kresba                   hotová kresba (data kresby, nebo odkaz do úložiště u velkých)

import type { Ink } from "../shared/codec";
import { colorName, inkKind, mixInks } from "../shared/ink";
import { CFG, type Recipe, type ShopRow } from "./config";
import * as most from "./most";

export const ITEM = {
  pergamen: "kresby:pergamen",
  papir: "kresby:papir",
  kniha: "kresby:kniha",
  kresba: "kresby:kresba",
  inkoust: "kresby:inkoust",
  recipe: (id: string) => "kresby:inkoust:" + id,
};

/** druh listu podle kódu (z nastavení, CFG.papiry) */
export const paperDef = (kod: number) => CFG.papiry.find((x) => x.kod === kod) ?? CFG.papiry[0];
/** id předmětu listu: kód 0 a 1 mají historická id */
export const sheetItem = (kod: number) => (kod === 0 ? ITEM.pergamen : kod === 1 ? ITEM.papir : "kresby:list:" + (CFG.papiry.find((x) => x.kod === kod)?.id ?? kod));
const paperOfItem = (id: string | null): number | null => {
  if (!id) return null;
  for (const x of CFG.papiry) if (sheetItem(x.kod) === id) return x.kod;
  return null;
};
const BOOK_NAME = "Kniha o barvách a inkoustech";
// texty předmětů: jeden řádek - KCDC 1.7.1 odmítne řídicí znaky (i \n) s "Invalid custom item text" (ověřeno na serveru)
const BOOK_TEXT = "Jak z duběnek, sazí, mědi, bylin a zlata připravit inkoust, jak barvy míchat a ředit. Použij ji, chceš-li inkoust připravit.";

const guids = new Map<string, string>(); // id -> GUID
const ids = new Map<string, string>(); // GUID (malými) -> id
const log = (t: string) => console.log("[kresby] " + t);

export const guidOf = (id: string) => guids.get(id) ?? id;

function reg(id: string, def: Parameters<typeof most.registerCustomItem>[2], fallbacks: string[] = []) {
  for (const visual of [def.visual, ...fallbacks]) {
    try {
      const g = most.registerCustomItem(id, visual, { ...def, visual });
      guids.set(id, g);
      ids.set(g.toLowerCase(), id);
      return;
    } catch (e) {
      // typ už je registrovaný s jinou definicí (změna v nastavení za běhu): platí dál starý, nová po restartu serveru
      if (guids.has(id)) return void log(`předmět ${id}: změna definice (název, váha, vzhled) se projeví po restartu serveru`);
      log(`předmět ${id} se vzhledem ${visual}: ${String(e)}`);
    }
  }
}

export function registerItems() {
  const m = CFG.materials;
  const doc = [m.sheetVisual, m.bookVisual, m.drawingVisual];
  for (const x of CFG.papiry) reg(sheetItem(x.kod), { name: x.name, description: x.popis, visual: m.sheetVisual, weight: x.vaha, price: x.cena }, doc);
  reg(ITEM.kniha, { name: BOOK_NAME, description: BOOK_TEXT, visual: m.bookVisual, weight: 0.5, price: 40, stackable: false, usable: true, useLabel: "Připravit inkoust" }, doc);
  reg(ITEM.kresba, { name: "Kresba", description: "Kresba na listu.", visual: m.drawingVisual, weight: m.sheetWeight, price: 1, stackable: false, usable: true, useLabel: "Prohlédnout" }, doc);
  reg(ITEM.inkoust, { name: "Inkoust", description: "Lahvička inkoustu.", visual: m.inkVisual, weight: m.inkWeight, price: 6, stackable: false });
  for (const r of CFG.recipes) {
    reg(ITEM.recipe(r.id), { name: r.name, description: r.about, visual: m.inkVisual, weight: m.inkWeight, price: 8, stackable: false });
  }
}

/** id vlastního předmětu kreseb pro řádek inventáře, nebo null */
export function kindOf(r: InventoryRow): string | null {
  if (r.name.startsWith("kresby:")) return r.name;
  return ids.get(r.item.toLowerCase()) ?? null;
}

export const isInk = (id: string | null) => !!id && (id === ITEM.inkoust || id.startsWith("kresby:inkoust:"));

// ---------------------------------------------------------------------------
// inkoust v lahvičce

export interface InkData {
  rgb: [number, number, number];
  f: number; // flags
  st: number; // sytost
  dr: number; // kapky
  mx: number; // kolik se do lahvičky vejde
}

export interface InkRow {
  row: string;
  name: string;
  ink: Ink;
  drops: number;
  max: number;
}

export const recipeOf = (id: string) => CFG.recipes.find((r) => r.id === id || r.name.toLowerCase() === id.toLowerCase());

function recipeData(r: Recipe, drops = r.drops): InkData {
  return { rgb: [...r.rgb] as [number, number, number], f: r.flags, st: r.strength, dr: drops, mx: Math.max(r.drops, CFG.materials.maxDrops) };
}

export function inkText(name: string, d: InkData): string {
  const kind = inkKind(d.f);
  void name;
  return `Barva: ${colorName(d.rgb, d.f)}. Zbývá ${d.dr} z ${d.mx} kapek. ${kind[0].toUpperCase() + kind.slice(1)}, sytost ${Math.round(d.st / 2.55)} %. Kreslí se jím brkem nebo štětcem.`;
}

export function inkMeta(name: string, d: InkData): most.Meta {
  return { name, description: inkText(name, d), data: { ...d } };
}

function readInk(r: InventoryRow, kind: string): InkData | null {
  const d = most.customData(r);
  if (d && Array.isArray(d.rgb) && typeof d.dr === "number") {
    return { rgb: [d.rgb[0] | 0, d.rgb[1] | 0, d.rgb[2] | 0], f: d.f | 0, st: d.st ?? 255, dr: d.dr, mx: d.mx ?? CFG.materials.maxDrops };
  }
  // bez dat (např. dal ho jiný resource): plná lahvička podle receptu
  const rec = kind.startsWith("kresby:inkoust:") ? recipeOf(kind.slice("kresby:inkoust:".length)) : null;
  return rec ? recipeData(rec) : null;
}

export function inksOf(p: Player): InkRow[] {
  const out: InkRow[] = [];
  for (const r of most.rows(p)) {
    const kind = kindOf(r);
    if (!isInk(kind)) continue;
    const d = readInk(r, kind!);
    if (!d || d.dr <= 0) continue;
    const rec = kind!.startsWith("kresby:inkoust:") ? recipeOf(kind!.slice(15)) : null;
    out.push({ row: r.id, name: most.customName(r) ?? rec?.name ?? "Inkoust", ink: { rgb: d.rgb, flags: d.f, strength: d.st }, drops: d.dr, max: d.mx });
  }
  return out;
}

function inkRowData(p: Player, rowId: string): { r: InventoryRow; d: InkData; name: string } | null {
  const r = most.rows(p).find((x) => x.id === rowId);
  const kind = r ? kindOf(r) : null;
  if (!r || !isInk(kind)) return null;
  const d = readInk(r, kind!);
  return d ? { r, d, name: most.customName(r) ?? recipeOf(kind!.slice(15))?.name ?? "Inkoust" } : null;
}

export function giveInk(p: Player, name: string, d: InkData, recipe?: Recipe): boolean {
  return most.giveCustom(p, guidOf(recipe ? ITEM.recipe(recipe.id) : ITEM.inkoust), inkMeta(name, d));
}

export const giveRecipeInk = (p: Player, r: Recipe, drops = r.drops) => giveInk(p, r.name, recipeData(r, drops), r);

/** herní „Oakgall ink“ z kořisti se převede na lahvičku s kapkami */
export async function convertNative(p: Player): Promise<number> {
  const n = await most.count(p, CFG.materials.nativeInk);
  if (n <= 0) return 0;
  if (!(await most.take(p, CFG.materials.nativeInk, n))) return 0;
  const rec = recipeOf("dubenka") ?? CFG.recipes[0];
  for (let i = 0; i < n; i++) giveRecipeInk(p, rec, CFG.materials.nativeInkDrops);
  return n;
}

// ---------------------------------------------------------------------------
// listy, nástroje

/** kolik listů kterého druhu hráč má: index = kód papíru */
export function sheetsOf(p: Player): number[] {
  const out: number[] = [];
  for (const x of CFG.papiry) out[x.kod] = 0;
  for (const r of most.rows(p)) {
    const k = paperOfItem(kindOf(r));
    if (k !== null) out[k] = (out[k] ?? 0) + r.amount;
  }
  return out;
}

export function takeSheet(p: Player, paper: number): boolean {
  const want = sheetItem(paper);
  const r = most.rows(p).find((x) => kindOf(x) === want);
  return !!r && most.takeRow(p, r.id, 1);
}

export const giveSheet = (p: Player, paper: number, n = 1) => most.giveCustom(p, guidOf(sheetItem(paper)), {}, n);
export const giveBook = (p: Player) => most.giveCustom(p, guidOf(ITEM.kniha), {});

/** nástroje, které hráč má: 0 brk (husí brky), 1 štětec (sada štětců), 2 uhel, 3 škrabka (vždy) */
export async function toolsOf(p: Player): Promise<{ tools: number[]; charcoal: number }> {
  const t = CFG.nastroje;
  const has = async (n: { zapnuto: boolean; predmet: string }) => (!n.zapnuto ? 0 : n.predmet ? await most.count(p, n.predmet) : 1);
  const [q, b, c, s] = await Promise.all([has(t.pen), has(t.brush), has(t.charcoal), has(t.scrape)]);
  const tools: number[] = [];
  if (q > 0) tools.push(0);
  if (b > 0) tools.push(1);
  if (c > 0) tools.push(2);
  if (s > 0) tools.push(3);
  // uhel bez předmětu (predmet "") se nespotřebovává: "nekonečně"
  return { tools, charcoal: t.charcoal.predmet ? c : c > 0 ? 1e6 : 0 };
}

/**
 * Spotřeba hotové kresby: kapky z lahviček (use: řádek -> kapky), jeden list, kusy uhlu. Nejdřív se vše ověří,
 * pak se odebere. Vrací null, nebo důvod, proč to nejde.
 */
export async function consume(p: Player, use: Map<string, number>, paper: number, charcoal: number): Promise<string | null> {
  const plan: { row: string; d: InkData; name: string; need: number }[] = [];
  for (const [row, drops] of use) {
    const need = Math.ceil(drops - 1e-9);
    if (need <= 0) continue;
    const x = inkRowData(p, row);
    if (!x) return "Inkoust už u sebe nemáš.";
    if (x.d.dr < need) return `„${x.name}“ nestačí na celou kresbu.`;
    plan.push({ row, d: x.d, name: x.name, need });
  }
  if ((sheetsOf(p)[paper] ?? 0) < 1) return "Čistý list už u sebe nemáš.";
  const coal = CFG.nastroje.charcoal.predmet;
  if (coal && charcoal > 0 && (await most.count(p, coal)) < charcoal) return `Na kresbu je potřeba ${charcoal} kusů uhlu.`;
  if (coal && charcoal > 0 && !(await most.take(p, coal, charcoal))) return "Uhel se nepodařilo odebrat.";
  if (!takeSheet(p, paper)) return "List se nepodařilo odebrat.";
  for (const x of plan) {
    const d = { ...x.d, dr: x.d.dr - x.need };
    if (d.dr <= 0) {
      most.takeRow(p, x.row, 1);
      await most.give(p, CFG.materials.vialItem, 1); // prázdná lahvička zůstane
    } else most.updateRow(p, x.row, inkMeta(x.name, d));
  }
  return null;
}

// ---------------------------------------------------------------------------
// kniha o barvách: dílna (dialog) a čtení (nativní kniha hry v rukou)

export const needsText = (r: Recipe) => r.needs.map(([k, n]) => `${n}× ${CFG.ingredientNames[k] ?? k}`).join(", ");

async function hasNeeds(p: Player, r: Recipe): Promise<boolean> {
  if ((await most.count(p, CFG.materials.vialItem)) < 1) return false;
  for (const [k, n] of r.needs) if ((await most.count(p, k)) < n) return false;
  return true;
}

export function bookPages(): string[] {
  const pages = [
    `<title>${BOOK_NAME}</title><paragraph>Jak z duběnek, sazí, mědi, bylin a zlata připravit inkoust, jak barvy míchat a ředit. Na každý inkoust je třeba prázdná lahvička.</paragraph>` +
      `<heading>Míchání</heading><paragraph>Barvy se mísí jako pigmenty, ne jako světlo: modrá a žlutá dají zelenou. Poměr 3 : 1 až 1 : 3, do nové lahvičky.</paragraph>` +
      `<heading>Ředění</heading><paragraph>Voda přidá kapky a ubere sytost - na lavírování.</paragraph>`,
  ];
  for (let i = 0; i < CFG.recipes.length; i += 3) {
    pages.push(
      CFG.recipes
        .slice(i, i + 3)
        .map((r) => `<heading>${r.name}</heading><paragraph>${r.about[0].toUpperCase() + r.about.slice(1)}.</paragraph><note>${needsText(r)} a prázdná lahvička; ${r.drops} kapek.</note>`)
        .join(""),
    );
  }
  return pages;
}



async function pickInk(p: Player, title: string, exclude?: string): Promise<InkRow | null> {
  const inks = inksOf(p).filter((i) => i.row !== exclude);
  if (!inks.length) return null;
  const id = await most.menu(p, { title, options: [...inks.map((i) => ({ id: i.row, text: `${i.name} (${i.drops} kapek)` })), { id: "#zpet", text: "Zpět" }] });
  return inks.find((i) => i.row === id) ?? null;
}

export async function craft(p: Player, r: Recipe): Promise<boolean> {
  if (!(await hasNeeds(p, r))) return void most.notify(p, "Nemáš všechny suroviny a prázdnou lahvičku.", "warning"), false;
  for (const [k, n] of r.needs) if (!(await most.take(p, k, n))) return false;
  if (!(await most.take(p, CFG.materials.vialItem, 1))) return false;
  giveRecipeInk(p, r);
  await most.notify(p, "Připravil jsi: " + r.name + ".", "success");
  return true;
}

export async function mix(p: Player, a: string, b: string, ra: number, rb: number, total: number): Promise<boolean> {
  if ((await most.count(p, CFG.materials.vialItem)) < 1) return void most.notify(p, "Na směs potřebuješ prázdnou lahvičku.", "warning"), false;
  const A = inkRowData(p, a);
  const B = inkRowData(p, b);
  if (!A || !B || a === b) return false;
  const da = Math.floor((total * ra) / (ra + rb) + 0.5);
  const db = total - da;
  if (A.d.dr < da || B.d.dr < db) return void most.notify(p, "Na takovou směs nemáš dost inkoustu.", "warning"), false;
  const t = db / total;
  const ink = mixInks({ rgb: A.d.rgb, flags: A.d.f, strength: A.d.st }, { rgb: B.d.rgb, flags: B.d.f, strength: B.d.st }, t);
  for (const [x, need] of [[A, da], [B, db]] as const) {
    const left = x.d.dr - need;
    if (left <= 0) {
      most.takeRow(p, x.r.id, 1);
      await most.give(p, CFG.materials.vialItem, 1);
    } else most.updateRow(p, x.r.id, inkMeta(x.name, { ...x.d, dr: left }));
  }
  await most.take(p, CFG.materials.vialItem, 1);
  const name = "Inkoust – " + colorName(ink.rgb, ink.flags);
  giveInk(p, name, { rgb: ink.rgb, f: ink.flags, st: ink.strength, dr: total, mx: Math.max(total, CFG.materials.maxDrops) });
  await most.notify(p, "Namíchal jsi: " + name + ".", "success");
  return true;
}

export async function dilute(p: Player, rowId: string): Promise<boolean> {
  const x = inkRowData(p, rowId);
  if (!x) return false;
  let water: string | null = null;
  for (const w of CFG.materials.waterItems) if ((await most.count(p, w)) > 0) water = water ?? w;
  if (!water) return void most.notify(p, "Na ředění potřebuješ vodu.", "warning"), false;
  if (x.d.dr >= x.d.mx) return void most.notify(p, "Lahvička je plná.", "warning"), false;
  const add = Math.min(Math.max(1, Math.ceil(x.d.dr * CFG.michani.vodaPridava)), x.d.mx - x.d.dr);
  const st = Math.max(CFG.michani.minSytost, Math.floor((x.d.st * x.d.dr) / (x.d.dr + add) + 0.5));
  if (!(await most.take(p, water, 1))) return false;
  const name = x.name.includes("ředěn") ? x.name : x.name + " (ředěný)";
  most.updateRow(p, rowId, inkMeta(name, { ...x.d, dr: x.d.dr + add, st }));
  await most.notify(p, `Inkoust je ředěný: ${x.d.dr + add} kapek, sytost ${Math.round(st / 2.55)} %.`);
  return true;
}

export async function pour(p: Player, rowId: string): Promise<boolean> {
  if (!inkRowData(p, rowId) || !most.takeRow(p, rowId, 1)) return false;
  await most.give(p, CFG.materials.vialItem, 1);
  await most.notify(p, "Inkoust jsi vylil, lahvička je prázdná.");
  return true;
}

/** dílna (použití knihy): menu jako v KCD:MP */
export async function openBook(p: Player): Promise<void> {
  await convertNative(p);
  for (;;) {
    const inks = inksOf(p);
    const pick = await most.menu(p, {
      title: "Kniha o barvách",
      text: "Co budeš připravovat?",
      options: [
        { id: "recept", text: "Připravit inkoust podle receptu" },
        { id: "michat", text: "Smíchat dva inkousty", enabled: inks.length >= 2 },
        { id: "redit", text: "Zředit inkoust vodou", enabled: inks.length >= 1 },
        { id: "vylit", text: "Vylít inkoust", enabled: inks.length >= 1 },
        { id: "cist", text: "Číst knihu" },
        { id: "#zavrit", text: "Zavřít" },
      ],
    });
    if (pick === "recept") {
      const opts = [];
      for (const r of CFG.recipes) opts.push({ id: r.id, text: r.name + ((await hasNeeds(p, r)) ? "" : " (chybí suroviny)") });
      const id = await most.menu(p, { title: "Recepty", options: [...opts, { id: "#zpet", text: "Zpět" }] });
      const r = id ? recipeOf(id) : null;
      if (!r) continue;
      const ok = await hasNeeds(p, r);
      const go = await most.menu(p, {
        title: r.name,
        text: `${r.about}.\nSuroviny: ${needsText(r)} a prázdná lahvička.\nVydá ${r.drops} kapek.`,
        options: [{ id: "ano", text: "Připravit", enabled: ok }, { id: "#zpet", text: "Zpět" }],
      });
      if (go === "ano") await craft(p, r);
    } else if (pick === "michat") {
      const a = await pickInk(p, "Míchání: první inkoust");
      const b = a && (await pickInk(p, `Přimíchat k „${a.name}“:`, a.row));
      if (!a || !b) continue;
      const ratio = await most.menu(p, {
        title: `„${a.name}“ : „${b.name}“`,
        options: [...CFG.michani.pomery.map(([x, y]) => ({ id: x + ":" + y, text: `Poměr ${x} : ${y}` })), { id: "#zpet", text: "Zpět" }],
      });
      if (!ratio || ratio.startsWith("#")) continue;
      const amount = await most.menu(p, {
        title: "Kolik směsi?",
        options: [...CFG.michani.mnozstvi.map((n) => ({ id: String(n), text: `${n} kapek směsi` })), { id: "#zpet", text: "Zpět" }],
      });
      if (!amount || amount.startsWith("#")) continue;
      const [ra, rb] = ratio.split(":").map(Number);
      await mix(p, a.row, b.row, ra, rb, Number(amount));
    } else if (pick === "redit") {
      const i = await pickInk(p, "Ředění: který inkoust?");
      if (i) await dilute(p, i.row);
    } else if (pick === "vylit") {
      const i = await pickInk(p, "Vylít: který inkoust?");
      if (i) await pour(p, i.row);
    } else if (pick === "cist") {
      p.emit("kresby:kniha", JSON.stringify({ pages: bookPages() }));
      return;
    } else return;
  }
}

// ---------------------------------------------------------------------------
// krám písaře: nativní obchod hry (Vendor, groše hry), nebo nabídka placená přes most.economy

export function shopName(s: ShopRow): string {
  if (s.kind === "sheet") return paperDef(s.paper ?? 0)?.name ?? "List";
  if (s.kind === "book") return BOOK_NAME;
  if (s.kind === "ink") return recipeOf(s.recipe ?? "")?.name ?? "Inkoust";
  return s.name ?? s.item ?? "?";
}

/** řádky Vendor.setStock (každá třída předmětu jednou - proto má každý recept vlastní typ lahvičky) */
export function vendorStock(): VendorStockRow[] {
  const out: VendorStockRow[] = [];
  for (const s of CFG.shop) {
    if (s.kind === "plain" && s.item) out.push({ item: s.item, amount: 999, price: s.price });
    else if (s.kind === "sheet") out.push({ item: guidOf(sheetItem(s.paper ?? 0)), amount: 999, price: s.price });
    else if (s.kind === "book") out.push({ item: guidOf(ITEM.kniha), amount: 99, price: s.price });
    else if (s.kind === "ink") {
      const r = recipeOf(s.recipe ?? "");
      if (r) out.push({ item: guidOf(ITEM.recipe(r.id)), amount: 99, price: s.price, metadata: { custom: inkMeta(r.name, recipeData(r)) } });
    }
  }
  return out;
}

let vendor = 0;

export function openShop(p: Player): void {
  if (CFG.kram === "menu") return void menuShop(p);
  if (!vendor) vendor = Vendor.create({ name: CFG.pisar || "Písař (kresby)", buys: false });
  Vendor.setStock(vendor, vendorStock()); // zásoba se po každém otevření doplní
  if (!Vendor.open(vendor, p.id)) void menuShop(p);
}

export function onVendorTrade(v: number) {
  if (v === vendor && vendor) Vendor.setStock(vendor, vendorStock());
}

async function menuShop(p: Player): Promise<void> {
  for (;;) {
    const id = await most.menu(p, {
      title: CFG.pisar || "Písař",
      text: "Co si koupíš?",
      options: [...CFG.shop.map((s, i) => ({ id: String(i), text: `${shopName(s)} - ${s.price} gr` })), { id: "#zavrit", text: "Nic" }],
    });
    const s = id && !id.startsWith("#") ? CFG.shop[Number(id)] : null;
    if (!s) return;
    if (!(await most.pay(p, s.price, "kresby: " + shopName(s)))) {
      await most.notify(p, "Na to nemáš dost peněz.", "warning");
      continue;
    }
    if (s.kind === "plain" && s.item) await most.give(p, s.item, 1);
    else if (s.kind === "sheet") giveSheet(p, s.paper ?? 0);
    else if (s.kind === "book") giveBook(p);
    else if (s.kind === "ink") {
      const r = recipeOf(s.recipe ?? "");
      if (r) giveRecipeInk(p, r);
    }
    await most.notify(p, "Koupil jsi: " + shopName(s) + ".", "success");
  }
}

// ---------------------------------------------------------------------------
// správce: dát materiál

export async function adminGive(target: Player, what: string, arg?: string): Promise<string> {
  const n = Math.max(1, Math.min(20, Math.floor(Number(arg)) || 1));
  const sheet = CFG.papiry.find((x) => x.id === what || String(x.kod) === what);
  if (sheet) {
    giveSheet(target, sheet.kod, n);
  } else if (what === "kniha") {
    giveBook(target);
  } else if (what === "inkoust") {
    const r = recipeOf(arg ?? "") ?? CFG.recipes[(Math.floor(Number(arg)) || 1) - 1];
    if (!r) return `Neznámý recept. Recepty 1-${CFG.recipes.length} nebo id: ${CFG.recipes.map((x) => x.id).join(", ")}.`;
    giveRecipeInk(target, r);
  } else if (what === "nastroje") {
    const t = CFG.nastroje;
    for (const [x, n2] of [[t.pen, 1], [t.brush, 1], [t.charcoal, 3], [t.scrape, 1]] as const) if (x.zapnuto && x.predmet) await most.give(target, x.predmet, n2);
    await most.give(target, CFG.materials.vialItem, 2);
  } else if (what === "sada") {
    for (const x of CFG.papiry) giveSheet(target, x.kod, 3);
    for (const id of ["dubenka", "trezalka", "modr", "mesicek", "beloba", "zlato"]) {
      const r = recipeOf(id);
      if (r) giveRecipeInk(target, r);
    }
    await adminGive(target, "nastroje");
    giveBook(target);
  } else return `Co dát: ${CFG.papiry.map((x) => x.id).join(" | ")} | kniha | nastroje | sada [počet] | inkoust <číslo nebo id receptu>`;
  return `Dáno hráči ${target.nickname}: ${what}${arg ? " " + arg : ""}.`;
}
