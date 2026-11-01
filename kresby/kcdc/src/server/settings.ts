// Nastavení kreseb v editoru správy (F10 → Nastavení → Kresby; sprava/AGENTS.md, oddíl 2b).
//
// Všechno, co dřív šlo jen v kresby_config.js, jde upravit za běhu: inkousty a míchání, materiály (druhy listů,
// lahvička, kniha) a jejich ceny, obchod písaře, nástroje a jejich efekty, výkon (textury, LOD, rozpočty, kvóty),
// vývěsky a jejich umístění ("Vzít moji pozici") a moderace. Nový inkoust nebo druh listu se přidá celý z UI:
// zaregistruje se jeho předmět, prázdný list dostane texturu a krám ho nabídne.
//
// Uloženo v most.storage pod "kresby:nastaveni" (vývěsky ne - ty mají vlastní záznamy kresby:deska/<id>).
// Výchozí stav = kresby_config.js (KRESBY_CONFIG) nad výchozími hodnotami (config.ts). "Obnovit výchozí" smaže uložené.

import type { SettingsDef, SettingsField, SettingsObject, SettingsSetResult } from "../../../../sprava/src/settings-types";
import { normalFromYaw, type V3 } from "../shared/layout";
import { DEFAULT_LOOK, LOOK, SYSTEM_PAPERS, setLook, type PaperDef, type RGB } from "../shared/look";
import * as assets from "./assets";
import { broadcastCfg, create, relocate, remove as removeBoard } from "./boards";
import { CFG, type Config, type Paper, type Recipe, type ShopRow } from "./config";
import { registerItems } from "./materials";
import { storage } from "./most";
import { boards, type BoardRec } from "./store";

const KEY = "kresby:nastaveni";
const log = (t: string) => console.log("[kresby] " + t);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// výchozí stav (kresby_config.js nad config.ts), zachycený před uloženým nastavením
const BASE: Partial<Config> = {};
let baseLook = clone(DEFAULT_LOOK);
const EDITABLE = ["recipes", "ingredientNames", "papiry", "michani", "nastroje", "velikost", "materials", "shop", "kram", "pisar", "svet", "klient", "moderace",
  "maxPoints", "maxStrokes", "batchStrokes", "batchPoints", "cooldownMs", "maxInks", "tearDown", "useRange", "liveRange", "streamRange", "idleMs",
  "maxBoards", "maxSlots", "itemDataMax", "dataRate", "cacheBytes", "stojan"] as const;

function snapshotBase() {
  if (Object.keys(BASE).length) return;
  for (const k of EDITABLE) (BASE as any)[k] = clone((CFG as any)[k] ?? null);
  // nastavení vzhledu z papírů v configu
  baseLook = clone({ ...DEFAULT_LOOK, papers: papersToLook(CFG.papiry) });
}

// ---------------------------------------------------------------------------
// převody

const hex = (rgb: number[]) => "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const rgbOf = (h: unknown, def: RGB): RGB => {
  const m = typeof h === "string" ? /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(h) : null;
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : def;
};
const num = (v: unknown, def: number) => (typeof v === "number" && Number.isFinite(v) ? v : def);
const str = (v: unknown, def = "") => (typeof v === "string" ? v : def);
const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);

const DRUH = { pruhledny: 0, kryci: 1, zlaty: 3 } as Record<string, number>;
const druhOf = (flags: number) => (flags & 2 ? "zlaty" : flags & 1 ? "kryci" : "pruhledny");

function papersToLook(list: Paper[]): PaperDef[] {
  const out: PaperDef[] = list.map((p) => ({ kod: p.kod, id: p.id, name: p.name, rgb: rgbOf(p.barva, [232, 218, 188]), styl: p.styl }));
  for (const s of SYSTEM_PAPERS) if (!out.some((p) => p.kod === s.kod || p.id === s.id)) out.push({ ...s, rgb: [...s.rgb] as RGB });
  return out;
}

/** deska -> pole nastavení (divák stojí před deskou a dívá se na ni) */
function boardToValue(b: BoardRec) {
  const sklon = (Math.asin(Math.max(-1, Math.min(1, b.n[2]))) * 180) / Math.PI;
  const nyaw = (Math.atan2(-b.n[0], b.n[1]) * 180) / Math.PI;
  let yaw = nyaw + 180;
  if (yaw > 180) yaw -= 360;
  const a = (yaw * Math.PI) / 180;
  const f = [-Math.sin(a), Math.cos(a)];
  const vz = 0.8;
  const vy = 1.5;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    id: b.id,
    druh: b.kind,
    pozice: { x: r(b.pos[0] - f[0] * vz), y: r(b.pos[1] - f[1] * vz), z: r(b.pos[2] - vy), yaw: Math.round(yaw * 10) / 10 },
    vzdalenost: vz,
    vyska: vy,
    sklon: Math.round(sklon * 10) / 10,
    sloupce: b.cols,
    radky: b.rows,
    sirka: b.w,
    vyskaDesky: b.h,
  };
}

function valueToFace(v: any): { pos: V3; n: V3 } {
  const yaw = num(v?.pozice?.yaw, 0);
  const a = (yaw * Math.PI) / 180;
  const f = [-Math.sin(a), Math.cos(a)];
  const vz = num(v.vzdalenost, 0.8);
  const vy = num(v.vyska, 1.5);
  const pos: V3 = [num(v.pozice?.x, 0) + f[0] * vz, num(v.pozice?.y, 0) + f[1] * vz, num(v.pozice?.z, 0) + vy];
  return { pos, n: normalFromYaw(yaw + 180, num(v.sklon, 0)) };
}

// ---------------------------------------------------------------------------
// hodnota pro editor

export function value(): SettingsObject {
  const fx = LOOK.fx;
  const t = CFG.nastroje;
  return clone({
    inkousty: {
      recepty: CFG.recipes.map((r) => ({
        id: r.id,
        nazev: r.name,
        barva: hex(r.rgb),
        druh: druhOf(r.flags),
        sytost: Math.round(r.strength / 2.55),
        kapek: r.drops,
        popis: r.about,
        suroviny: r.needs.map(([predmet, pocet]) => ({ predmet, pocet, nazev: CFG.ingredientNames[predmet] ?? "" })),
      })),
      michani: {
        model: LOOK.mix,
        pomery: CFG.michani.pomery.map(([a, b]) => ({ a, b })),
        mnozstvi: CFG.michani.mnozstvi,
        vodaPridava: Math.round(CFG.michani.vodaPridava * 100),
        minSytost: Math.round(CFG.michani.minSytost / 2.55),
      },
      spotreba: {
        kapkaPlocha: CFG.materials.dropArea,
        uhelPlocha: CFG.materials.charcoalArea,
        maxKapek: CFG.materials.maxDrops,
        maxInkoustu: CFG.maxInks,
        herniInkoust: CFG.materials.nativeInk,
        herniInkoustKapek: CFG.materials.nativeInkDrops,
      },
    },
    materialy: {
      papiry: CFG.papiry.map((p) => ({ kod: p.kod, id: p.id, nazev: p.name, popis: p.popis, barva: p.barva, styl: p.styl, cena: p.cena, vaha: p.vaha })),
      predmety: {
        prazdnaLahvicka: CFG.materials.vialItem,
        voda: CFG.materials.waterItems,
        vahaLahvicky: CFG.materials.inkWeight,
        vzhledListu: CFG.materials.sheetVisual,
        vzhledKnihy: CFG.materials.bookVisual,
        vzhledLahvicky: CFG.materials.inkVisual,
        vzhledKresby: CFG.materials.drawingVisual,
      },
      obchod: {
        rezim: CFG.kram,
        nazev: CFG.pisar,
        zbozi: CFG.shop.map((s) => ({ druh: s.kind, papir: s.paper ?? 0, recept: s.recipe ?? null, predmet: s.item ?? null, nazev: s.name ?? "", cena: s.price })),
      },
    },
    nastroje: {
      brk: { nazev: t.pen.nazev, zapnuto: t.pen.zapnuto, predmet: t.pen.predmet || null, naber: fx.pen.taper, vysychani: fx.pen.fade, kanky: fx.pen.blot, tvrdost: fx.pen.hardness },
      stetec: { nazev: t.brush.nazev, zapnuto: t.brush.zapnuto, predmet: t.brush.predmet || null, vysychani: fx.brush.fade, mokryOkraj: fx.brush.wet, tvrdost: fx.brush.hardness },
      uhel: { nazev: t.charcoal.nazev, zapnuto: t.charcoal.zapnuto, predmet: t.charcoal.predmet || null, zrno: fx.charcoal.grain, tvrdost: fx.charcoal.hardness },
      skrabka: { nazev: t.scrape.nazev, zapnuto: t.scrape.zapnuto, predmet: t.scrape.predmet || null, sila: fx.scrape.strength },
      zlato: { lesk: fx.gold.glint },
      velikost: { min: CFG.velikost.min, max: CFG.velikost.max },
    },
    vykon: {
      svet: {
        rezim: CFG.svet.rezim,
        sirka: CFG.svet.sirka,
        kvalita: CFG.svet.kvalita,
        shard: CFG.svet.shard,
        horky: CFG.svet.horky,
        reloadS: Math.round(CFG.svet.reloadMs / 1000),
        konzole: CFG.svet.konzole,
        lesk: CFG.svet.lesk,
        rozpocetMs: CFG.svet.rozpocetMs,
        odsazeni: Math.round(CFG.svet.odsazeni * 1000),
      },
      limity: {
        maxPoints: CFG.maxPoints,
        maxStrokes: CFG.maxStrokes,
        batchStrokes: CFG.batchStrokes,
        batchPoints: CFG.batchPoints,
        itemDataMax: CFG.itemDataMax,
        maxBoards: CFG.maxBoards,
        maxSlots: CFG.maxSlots,
        dataRateKB: Math.round(CFG.dataRate / 1024),
        cacheMB: Math.round(CFG.cacheBytes / 1048576),
        idleMin: Math.round(CFG.idleMs / 60000),
      },
      dosahy: { useRange: CFG.useRange, liveRange: CFG.liveRange, streamRange: CFG.streamRange },
      klient: {
        platno: CFG.klient.platno,
        useKey: CFG.klient.useKey,
        cacheMB: Math.round(CFG.klient.cacheBytes / 1048576),
        gizmoUnits: CFG.klient.gizmoUnits,
        gizmoIds: CFG.klient.gizmoIds,
        drawRange: CFG.klient.drawRange,
        paperRange: CFG.klient.paperRange,
      },
    },
    vyvesky: { seznam: [...boards.values()].filter((b) => !b.owner).sort((a, b) => a.id - b.id).map(boardToValue) }, // desky jiných resource (škola) spravuje jejich vlastník
    moderace: {
      tearDown: CFG.tearDown,
      cooldownS: Math.round(CFG.cooldownMs / 1000),
      maxVystavenych: CFG.moderace.maxVystavenych,
      zakazanaSlova: CFG.moderace.zakazanaSlova,
    },
  }) as SettingsObject;
}

// ---------------------------------------------------------------------------
// použití hodnoty (bez vývěsek)

function apply(v: any) {
  const ink = v?.inkousty ?? {};
  if (Array.isArray(ink.recepty)) {
    CFG.recipes = ink.recepty.map(
      (r: any): Recipe => ({
        id: slug(str(r.id) || str(r.nazev)) || "inkoust",
        name: str(r.nazev, "Inkoust"),
        rgb: rgbOf(r.barva, [38, 30, 28]),
        flags: DRUH[str(r.druh)] ?? 0,
        strength: Math.round(Math.max(5, Math.min(100, num(r.sytost, 90))) * 2.55),
        drops: Math.max(1, Math.round(num(r.kapek, 30))),
        needs: (Array.isArray(r.suroviny) ? r.suroviny : []).filter((x: any) => x?.predmet).map((x: any) => [str(x.predmet), Math.max(1, Math.round(num(x.pocet, 1)))] as [string, number]),
        about: str(r.popis),
      }),
    );
    for (const r of ink.recepty) for (const x of r.suroviny ?? []) if (x?.predmet && x.nazev) CFG.ingredientNames[x.predmet] = str(x.nazev);
  }
  const m = ink.michani;
  if (m) {
    setLook({ mix: m.model === "svetlo" ? "svetlo" : "pigment" });
    if (Array.isArray(m.pomery) && m.pomery.length) CFG.michani.pomery = m.pomery.map((x: any) => [Math.max(1, Math.round(num(x.a, 1))), Math.max(1, Math.round(num(x.b, 1)))]);
    if (Array.isArray(m.mnozstvi) && m.mnozstvi.length) CFG.michani.mnozstvi = m.mnozstvi.map((x: any) => Math.max(1, Math.round(num(x, 10))));
    CFG.michani.vodaPridava = num(m.vodaPridava, 50) / 100;
    CFG.michani.minSytost = Math.round(num(m.minSytost, 16) * 2.55);
  }
  const sp = ink.spotreba;
  if (sp) {
    CFG.materials.dropArea = Math.max(100, num(sp.kapkaPlocha, 2500));
    CFG.materials.charcoalArea = Math.max(1000, num(sp.uhelPlocha, 60000));
    CFG.materials.maxDrops = Math.max(1, num(sp.maxKapek, 60));
    CFG.maxInks = Math.max(1, Math.min(16, num(sp.maxInkoustu, 12)));
    if (sp.herniInkoust) CFG.materials.nativeInk = str(sp.herniInkoust);
    CFG.materials.nativeInkDrops = Math.max(1, num(sp.herniInkoustKapek, 30));
  }
  const mat = v?.materialy ?? {};
  if (Array.isArray(mat.papiry) && mat.papiry.length) {
    CFG.papiry = mat.papiry.map(
      (p: any, i: number): Paper => ({
        kod: Math.max(0, Math.min(31, Math.round(num(p.kod, i)))),
        id: slug(str(p.id) || str(p.nazev)) || "list" + i,
        name: str(p.nazev, "List"),
        popis: str(p.popis).replace(/[\u0000-\u001f]+/g, " "),
        barva: str(p.barva, "#e8dabc"),
        styl: p.styl === "papir" || p.styl === "hladky" ? p.styl : "pergamen",
        cena: Math.max(0, Math.round(num(p.cena, 2))),
        vaha: Math.max(0, num(p.vaha, 0.02)),
      }),
    );
    setLook({ papers: papersToLook(CFG.papiry) });
  }
  const pr = mat.predmety;
  if (pr) {
    if (pr.prazdnaLahvicka) CFG.materials.vialItem = str(pr.prazdnaLahvicka);
    if (Array.isArray(pr.voda)) CFG.materials.waterItems = pr.voda.filter(Boolean).map(String);
    CFG.materials.inkWeight = num(pr.vahaLahvicky, CFG.materials.inkWeight);
    for (const [k, f] of [["vzhledListu", "sheetVisual"], ["vzhledKnihy", "bookVisual"], ["vzhledLahvicky", "inkVisual"], ["vzhledKresby", "drawingVisual"]] as const) if (pr[k]) (CFG.materials as any)[f] = str(pr[k]);
  }
  const ob = mat.obchod;
  if (ob) {
    CFG.kram = ob.rezim === "menu" ? "menu" : "nativni";
    CFG.pisar = str(ob.nazev, "Písař");
    if (Array.isArray(ob.zbozi)) {
      CFG.shop = ob.zbozi.map((z: any): ShopRow => {
        const kind = z.druh === "kniha" ? "book" : z.druh === "inkoust" || z.druh === "ink" ? "ink" : z.druh === "predmet" || z.druh === "plain" ? "plain" : z.druh === "book" ? "book" : "sheet";
        return { kind, paper: Math.round(num(z.papir, 0)), recipe: str(z.recept) || undefined, item: str(z.predmet) || undefined, name: str(z.nazev) || undefined, price: Math.max(0, Math.round(num(z.cena, 1))) };
      });
    }
  }
  const t = v?.nastroje;
  if (t) {
    const tool = (src: any, dst: { nazev: string; zapnuto: boolean; predmet: string }) => {
      if (!src) return;
      dst.nazev = str(src.nazev, dst.nazev);
      dst.zapnuto = src.zapnuto !== false;
      dst.predmet = str(src.predmet);
    };
    tool(t.brk, CFG.nastroje.pen);
    tool(t.stetec, CFG.nastroje.brush);
    tool(t.uhel, CFG.nastroje.charcoal);
    tool(t.skrabka, CFG.nastroje.scrape);
    setLook({
      fx: {
        pen: { taper: num(t.brk?.naber, 0.65), fade: num(t.brk?.vysychani, 1600), blot: num(t.brk?.kanky, 0.14), hardness: num(t.brk?.tvrdost, 0.85) },
        brush: { fade: num(t.stetec?.vysychani, 2600), wet: num(t.stetec?.mokryOkraj, 0.7), hardness: num(t.stetec?.tvrdost, 0.25) },
        charcoal: { grain: num(t.uhel?.zrno, 1), hardness: num(t.uhel?.tvrdost, 0.55) },
        scrape: { strength: num(t.skrabka?.sila, 1) },
        gold: { glint: num(t.zlato?.lesk, 0.45) },
      },
    });
    const lo = Math.max(0.5, num(t.velikost?.min, 0.5));
    CFG.velikost = { min: lo, max: Math.max(lo + 0.5, Math.min(40, num(t.velikost?.max, 40))) };
  }
  const vk = v?.vykon;
  if (vk?.svet) {
    const s = vk.svet;
    CFG.svet.rezim = s.rezim === "cary" || s.rezim === "oboji" ? s.rezim : "textura";
    CFG.svet.sirka = [512, 1024, 2048].includes(s.sirka) ? s.sirka : 1024;
    CFG.svet.kvalita = s.kvalita === 1 ? 1 : 2;
    CFG.svet.shard = Math.max(1, Math.round(num(s.shard, 24)));
    CFG.svet.horky = Math.max(1, Math.min(CFG.svet.shard, Math.round(num(s.horky, 3))));
    CFG.svet.reloadMs = Math.max(5, num(s.reloadS, 30)) * 1000;
    CFG.svet.konzole = s.konzole !== false;
    CFG.svet.lesk = Math.max(0, Math.min(255, num(s.lesk, 30)));
    CFG.svet.rozpocetMs = Math.max(1, num(s.rozpocetMs, 6));
    CFG.svet.odsazeni = Math.max(0, num(s.odsazeni, 4)) / 1000;
  }
  if (vk?.limity) {
    const l = vk.limity;
    CFG.maxPoints = Math.max(100, num(l.maxPoints, 15000));
    CFG.maxStrokes = Math.max(10, num(l.maxStrokes, 2000));
    CFG.batchStrokes = Math.max(1, num(l.batchStrokes, 40));
    CFG.batchPoints = Math.max(50, num(l.batchPoints, 3000));
    CFG.itemDataMax = Math.max(0, Math.min(16000, num(l.itemDataMax, 15000)));
    CFG.maxBoards = Math.max(1, num(l.maxBoards, 500));
    CFG.maxSlots = Math.max(1, Math.min(48, num(l.maxSlots, 24)));
    CFG.dataRate = Math.max(8, num(l.dataRateKB, 256)) * 1024;
    CFG.cacheBytes = Math.max(1, num(l.cacheMB, 32)) * 1048576;
    CFG.idleMs = Math.max(1, num(l.idleMin, 10)) * 60000;
  }
  if (vk?.dosahy) {
    CFG.useRange = num(vk.dosahy.useRange, 3.5);
    CFG.liveRange = num(vk.dosahy.liveRange, 35);
    CFG.streamRange = num(vk.dosahy.streamRange, 60);
  }
  if (vk?.klient) {
    const k = vk.klient;
    CFG.klient.platno = k.platno === "nativni" || k.platno === "web" ? k.platno : "auto";
    CFG.klient.useKey = str(k.useKey, "f") || "f";
    CFG.klient.cacheBytes = Math.max(1, num(k.cacheMB, 8)) * 1048576;
    CFG.klient.gizmoUnits = num(k.gizmoUnits, 6000);
    CFG.klient.gizmoIds = num(k.gizmoIds, 96);
    CFG.klient.drawRange = num(k.drawRange, 14);
    CFG.klient.paperRange = num(k.paperRange, 40);
  }
  const mod = v?.moderace;
  if (mod) {
    CFG.tearDown = mod.tearDown === "author" || mod.tearDown === "admin" ? mod.tearDown : "anyone";
    CFG.cooldownMs = Math.max(0, num(mod.cooldownS, 60)) * 1000;
    CFG.moderace.maxVystavenych = Math.max(0, Math.round(num(mod.maxVystavenych, 0)));
    CFG.moderace.zakazanaSlova = (Array.isArray(mod.zakazanaSlova) ? mod.zakazanaSlova : []).map(String).map((x: string) => x.trim()).filter(Boolean);
  }
}

// ---------------------------------------------------------------------------
// vývěsky

function applyBoards(list: any[], by: string): string[] {
  const msgs: string[] = [];
  const keep = new Set<number>();
  for (const v of list) {
    const id = Math.round(num(v.id, 0));
    const b = id ? boards.get(id) : undefined;
    const { pos, n } = valueToFace(v);
    const kind = v.druh === "stojan" || v.druh === "kram" ? v.druh : "deska";
    const cols = Math.max(1, Math.round(num(v.sloupce, 3)));
    const rows = Math.max(1, Math.round(num(v.radky, 2)));
    const w = Math.max(0.2, num(v.sirka, 1.5));
    const h = Math.max(0.2, num(v.vyskaDesky, 0.75));
    if (!b) {
      const yaw = ((Math.atan2(-n[0], n[1]) * 180) / Math.PI + 360) % 360;
      const r = create(kind, { pos, n, w, h, cols: kind === "stojan" ? 1 : cols, rows: kind === "stojan" ? 1 : rows }, by, kind === "stojan" ? { yaw, model: CFG.stojan.model } : {});
      if (typeof r === "string") msgs.push(r);
      else {
        keep.add(r.id);
        msgs.push(`Nová deska ${r.id}.`);
      }
      continue;
    }
    keep.add(b.id);
    const moved = Math.hypot(pos[0] - b.pos[0], pos[1] - b.pos[1], pos[2] - b.pos[2]) > 0.005 || Math.hypot(n[0] - b.n[0], n[1] - b.n[1], n[2] - b.n[2]) > 0.004;
    const resized = b.cols !== cols || b.rows !== rows || Math.abs(b.w - w) > 0.001 || Math.abs(b.h - h) > 0.001 || b.kind !== kind;
    if (moved || resized) {
      relocate(b, { pos, n, w, h, cols: kind === "kram" ? 0 : cols, rows: kind === "kram" ? 0 : rows, kind, yaw: ((Math.atan2(-n[0], n[1]) * 180) / Math.PI + 360) % 360 });
      msgs.push(`Deska ${b.id} ${moved ? "přesunuta" : "upravena"}.`);
    }
  }
  for (const b of [...boards.values()]) {
    if (keep.has(b.id) || b.owner) continue;
    removeBoard(b);
    msgs.push(`Deska ${b.id} smazána (kresby z ní zůstaly v úložišti).`);
  }
  return msgs;
}

// ---------------------------------------------------------------------------

function check(v: any): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  const ids = new Set<string>();
  (v?.inkousty?.recepty ?? []).forEach((r: any, i: number) => {
    const id = slug(str(r.id) || str(r.nazev));
    if (!id) errors.push({ path: `inkousty.recepty.${i}.id`, message: "Recept potřebuje id (písmena, číslice)." });
    else if (ids.has(id)) errors.push({ path: `inkousty.recepty.${i}.id`, message: `Id „${id}“ už má jiný recept.` });
    ids.add(id);
  });
  const kody = new Set<number>();
  (v?.materialy?.papiry ?? []).forEach((p: any, i: number) => {
    const k = Math.round(num(p.kod, -1));
    if (k < 0 || k > 31) errors.push({ path: `materialy.papiry.${i}.kod`, message: "Kód listu je 0 až 31." });
    else if (kody.has(k)) errors.push({ path: `materialy.papiry.${i}.kod`, message: `Kód ${k} už má jiný list.` });
    kody.add(k);
  });
  if (!(v?.materialy?.papiry ?? []).length) errors.push({ path: "materialy.papiry", message: "Aspoň jeden druh listu." });
  if (num(v?.nastroje?.velikost?.max, 40) <= num(v?.nastroje?.velikost?.min, 0.5)) errors.push({ path: "nastroje.velikost.max", message: "Největší musí být větší než nejmenší." });
  return errors;
}

/** po změně: nové předměty, prázdné listy, klienti, krám */
function afterChange() {
  registerItems();
  assets.ensureBlanks().catch((e) => console.log("[kresby] prázdné listy: " + String(e))); // po kouscích, na pozadí
  broadcastCfg();
}

async function persist() {
  const v = value() as any;
  delete v.vyvesky;
  await storage.set(KEY, { v: 1, value: v });
}

export async function load() {
  snapshotBase();
  const saved = (await storage.get(KEY)) as { v?: number; value?: unknown } | undefined;
  if (saved?.v === 1 && saved.value) {
    try {
      apply(saved.value);
      log("nastavení ze správy načteno");
    } catch (e) {
      log("uložené nastavení nejde použít: " + String(e));
    }
  }
}

async function set(v: SettingsObject, caller: Player | null): Promise<SettingsSetResult> {
  const errors = check(v);
  if (errors.length) return { ok: false, message: "Nastavení má chyby.", errors };
  apply(v);
  const msgs = Array.isArray((v as any).vyvesky?.seznam) ? applyBoards((v as any).vyvesky.seznam, caller ? "admin:" + caller.nickname : "nastaveni") : [];
  afterChange();
  await persist();
  return ["Uloženo.", ...msgs].join(" ");
}

async function reset(): Promise<SettingsSetResult> {
  for (const k of EDITABLE) (CFG as any)[k] = clone((BASE as any)[k]);
  setLook(clone(baseLook));
  await storage.delete(KEY);
  afterChange();
  return "Výchozí nastavení (kresby_config.js) obnoveno. Vývěsky zůstaly.";
}

// ---------------------------------------------------------------------------
// schéma

const ITEM_HELP = "Název předmětu z tabulek hry.";
const tool = (label: string, extra: SettingsField[]): SettingsField => ({
  type: "group",
  key: "",
  label,
  fields: [
    { type: "string", key: "nazev", label: "Název v plátně", maxLength: 32 },
    { type: "boolean", key: "zapnuto", label: "Smí se používat", default: true },
    { type: "item", key: "predmet", label: "Předmět, který hráč musí mít (prázdné = vždy)", help: ITEM_HELP },
    ...extra,
  ],
});

function schema(): SettingsField[] {
  const recipes = () => CFG.recipes.map((r) => ({ value: r.id, label: r.name }));
  return [
    {
      type: "group",
      key: "inkousty",
      label: "Inkousty a barvy",
      fields: [
        {
          type: "list",
          key: "recepty",
          label: "Recepty inkoustů",
          help: "Nový inkoust: Přidat. Předmět lahvičky se zaregistruje hned, krám a kniha ho nabídnou.",
          itemLabel: "nazev",
          unique: "id",
          addLabel: "Přidat inkoust",
          item: {
            type: "group",
            fields: [
              { type: "string", key: "id", label: "Id (písmena, číslice)", required: true, maxLength: 32 },
              { type: "string", key: "nazev", label: "Název", required: true, maxLength: 48 },
              { type: "color", key: "barva", label: "Barva", default: "#262018" },
              { type: "select", key: "druh", label: "Druh", options: [{ value: "pruhledny", label: "Průhledný (násobí se s podkladem)" }, { value: "kryci", label: "Krycí (navrch)" }, { value: "zlaty", label: "Zlatý (krycí, třpyt)" }], default: "pruhledny" },
              { type: "slider", key: "sytost", label: "Sytost", min: 5, max: 100, step: 1, unit: "%", default: 90 },
              { type: "number", key: "kapek", label: "Kapek v lahvičce", min: 1, max: 200, integer: true, default: 30 },
              { type: "text", key: "popis", label: "Popis (kniha, recept)", maxLength: 400 },
              {
                type: "list",
                key: "suroviny",
                label: "Suroviny (navíc vždy 1 prázdná lahvička)",
                addLabel: "Přidat surovinu",
                itemLabel: "nazev",
                item: { type: "group", fields: [{ type: "item", key: "predmet", label: "Předmět", required: true, help: ITEM_HELP }, { type: "number", key: "pocet", label: "Kusů", min: 1, max: 20, integer: true, default: 1 }, { type: "string", key: "nazev", label: "Název v knize", maxLength: 32 }] },
              },
            ],
          },
        },
        {
          type: "group",
          key: "michani",
          label: "Míchání a ředění",
          fields: [
            { type: "select", key: "model", label: "Míchání barev", options: [{ value: "pigment", label: "Jako barvy (modrá + žlutá = zelená)" }, { value: "svetlo", label: "Jako světlo (průměr)" }], default: "pigment" },
            { type: "list", key: "pomery", label: "Poměry míchání", addLabel: "Přidat poměr", item: { type: "group", fields: [{ type: "number", key: "a", label: "První", min: 1, max: 9, integer: true, default: 1 }, { type: "number", key: "b", label: "Druhý", min: 1, max: 9, integer: true, default: 1 }] } },
            { type: "list", key: "mnozstvi", label: "Množství směsi (kapek)", item: { type: "number", min: 1, max: 200, integer: true, default: 10 } },
            { type: "slider", key: "vodaPridava", label: "Ředění přidá kapek", min: 10, max: 200, step: 5, unit: "%", default: 50 },
            { type: "slider", key: "minSytost", label: "Nejmenší sytost po ředění", min: 5, max: 80, unit: "%", default: 16 },
          ],
        },
        {
          type: "group",
          key: "spotreba",
          label: "Spotřeba",
          fields: [
            { type: "number", key: "kapkaPlocha", label: "Plocha tahu na 1 kapku (px² při plném krytí)", min: 100, max: 100000, integer: true, default: 2500 },
            { type: "number", key: "uhelPlocha", label: "Plocha na 1 kus uhlu (px²)", min: 1000, max: 1000000, integer: true, default: 60000 },
            { type: "number", key: "maxKapek", label: "Nejvíc kapek v lahvičce", min: 1, max: 500, integer: true, default: 60 },
            { type: "number", key: "maxInkoustu", label: "Inkoustů v jedné kresbě", min: 1, max: 16, integer: true, default: 12 },
            { type: "item", key: "herniInkoust", label: "Herní inkoust, který se převede na lahvičku", help: ITEM_HELP },
            { type: "number", key: "herniInkoustKapek", label: "…kolik kapek", min: 1, max: 200, integer: true, default: 30 },
          ],
        },
      ],
    },
    {
      type: "group",
      key: "materialy",
      label: "Materiály a obchod",
      fields: [
        {
          type: "list",
          key: "papiry",
          label: "Druhy listů",
          help: "Nový list: Přidat (kód 2 a výš). Prázdný list dostane texturu ve světě, krám ho nabídne, když ho přidáš do zboží.",
          itemLabel: "nazev",
          unique: "id",
          addLabel: "Přidat druh listu",
          min: 1,
          item: {
            type: "group",
            fields: [
              { type: "number", key: "kod", label: "Kód (trvalý, v datech kreseb)", min: 0, max: 31, integer: true, default: 2 },
              { type: "string", key: "id", label: "Id", required: true, maxLength: 32 },
              { type: "string", key: "nazev", label: "Název", required: true, maxLength: 48 },
              { type: "string", key: "popis", label: "Popis předmětu (jeden řádek)", maxLength: 300 },
              { type: "color", key: "barva", label: "Barva podkladu", default: "#e8dabc" },
              { type: "select", key: "styl", label: "Povrch", options: [{ value: "pergamen", label: "Pergamen (skvrny)" }, { value: "papir", label: "Papír (žebrování)" }, { value: "hladky", label: "Hladký" }], default: "pergamen" },
              { type: "number", key: "cena", label: "Cena (gr)", min: 0, max: 100000, integer: true, default: 2 },
              { type: "number", key: "vaha", label: "Váha", min: 0, max: 10, step: 0.01, default: 0.02 },
            ],
          },
        },
        {
          type: "group",
          key: "predmety",
          label: "Předměty a vzhled",
          help: "Vzhled = herní drobnost, materiál nebo dokument (KCDC jiný nevezme). Změna vzhledu nebo váhy už registrovaného předmětu platí po restartu serveru.",
          fields: [
            { type: "item", key: "prazdnaLahvicka", label: "Prázdná lahvička", help: ITEM_HELP },
            { type: "list", key: "voda", label: "Voda k ředění", item: { type: "item" } },
            { type: "number", key: "vahaLahvicky", label: "Váha lahvičky inkoustu", min: 0, max: 10, step: 0.01, default: 0.25 },
            { type: "item", key: "vzhledListu", label: "Vzhled listu", help: ITEM_HELP },
            { type: "item", key: "vzhledKnihy", label: "Vzhled knihy o barvách", help: ITEM_HELP },
            { type: "item", key: "vzhledLahvicky", label: "Vzhled lahvičky inkoustu", help: ITEM_HELP },
            { type: "item", key: "vzhledKresby", label: "Vzhled kresby v brašně", help: ITEM_HELP },
          ],
        },
        {
          type: "group",
          key: "obchod",
          label: "Obchod písaře",
          fields: [
            { type: "select", key: "rezim", label: "Obchod", options: [{ value: "nativni", label: "Obchod hry (groše hry)" }, { value: "menu", label: "Nabídka placená přes most (měna frameworku)" }], default: "nativni" },
            { type: "string", key: "nazev", label: "Jméno obchodu", maxLength: 48, default: "Písař" },
            {
              type: "list",
              key: "zbozi",
              label: "Zboží",
              addLabel: "Přidat zboží",
              item: {
                type: "group",
                fields: [
                  { type: "select", key: "druh", label: "Co", options: [{ value: "sheet", label: "List" }, { value: "ink", label: "Inkoust" }, { value: "book", label: "Kniha o barvách" }, { value: "plain", label: "Herní předmět" }], default: "sheet" },
                  { type: "select", key: "papir", label: "Druh listu", options: () => CFG.papiry.map((p) => ({ value: p.kod, label: p.name })), showIf: { field: "druh", eq: "sheet" } },
                  { type: "select", key: "recept", label: "Inkoust", options: recipes, showIf: { field: "druh", eq: "ink" } },
                  { type: "item", key: "predmet", label: "Předmět", showIf: { field: "druh", eq: "plain" }, help: ITEM_HELP },
                  { type: "string", key: "nazev", label: "Název v nabídce", maxLength: 48, showIf: { field: "druh", eq: "plain" } },
                  { type: "number", key: "cena", label: "Cena (gr)", min: 0, max: 100000, integer: true, default: 1 },
                ],
              },
            },
          ],
        },
      ],
    },
    {
      type: "group",
      key: "nastroje",
      label: "Štětce a efekty",
      fields: [
        { ...tool("Brk", [
          { type: "slider", key: "naber", label: "Náběh a dotažení tahu", min: 0, max: 1, step: 0.05, default: 0.65 },
          { type: "slider", key: "vysychani", label: "Inkoust slábne po (px tahu)", min: 200, max: 6000, step: 100, default: 1600 },
          { type: "slider", key: "kanky", label: "Kaňky (pravděpodobnost)", min: 0, max: 0.5, step: 0.01, default: 0.14 },
          { type: "slider", key: "tvrdost", label: "Tvrdost okraje", min: 0.3, max: 1, step: 0.05, default: 0.85 },
        ]), key: "brk" } as SettingsField,
        { ...tool("Štětec", [
          { type: "slider", key: "vysychani", label: "Barva slábne po (px tahu)", min: 200, max: 8000, step: 100, default: 2600 },
          { type: "slider", key: "mokryOkraj", label: "Mokrý tmavší okraj", min: 0, max: 1.5, step: 0.05, default: 0.7 },
          { type: "slider", key: "tvrdost", label: "Tvrdost okraje", min: 0.05, max: 0.8, step: 0.05, default: 0.25 },
        ]), key: "stetec" } as SettingsField,
        { ...tool("Uhel", [
          { type: "slider", key: "zrno", label: "Zrno papíru", min: 0, max: 1, step: 0.05, default: 1 },
          { type: "slider", key: "tvrdost", label: "Tvrdost okraje", min: 0.2, max: 1, step: 0.05, default: 0.55 },
        ]), key: "uhel" } as SettingsField,
        { ...tool("Škrabka", [{ type: "slider", key: "sila", label: "Síla", min: 0.1, max: 1, step: 0.05, default: 1 }]), key: "skrabka" } as SettingsField,
        { type: "group", key: "zlato", label: "Zlatý inkoust", fields: [{ type: "slider", key: "lesk", label: "Třpyt", min: 0, max: 1, step: 0.05, default: 0.45 }] },
        {
          type: "group",
          key: "velikost",
          label: "Velikost stopy (px listu 768 × 512)",
          fields: [
            { type: "slider", key: "min", label: "Nejmenší", min: 0.5, max: 10, step: 0.5, unit: "px", default: 0.5 },
            { type: "slider", key: "max", label: "Největší", min: 2, max: 40, step: 0.5, unit: "px", default: 40 },
          ],
        },
      ],
    },
    {
      type: "group",
      key: "vykon",
      label: "Výkon a limity",
      fields: [
        {
          type: "group",
          key: "svet",
          label: "Kresby ve světě",
          fields: [
            { type: "select", key: "rezim", label: "Vykreslení", options: [{ value: "textura", label: "Textura na listu (osvětlená, stíny)" }, { value: "cary", label: "Ladicí čáry (Gizmos, svítí)" }, { value: "oboji", label: "Obojí (ladění)" }], default: "textura" },
            { type: "select", key: "sirka", label: "Rozlišení textury", options: [{ value: 512, label: "512 × 256 (≈ 90 kB)" }, { value: 1024, label: "1024 × 512 (≈ 350 kB)" }, { value: 2048, label: "2048 × 1024 (≈ 1,4 MB)" }], default: 1024 },
            { type: "select", key: "kvalita", label: "Vyhlazení rastru", options: [{ value: 1, label: "Rychlé" }, { value: 2, label: "Hladké (2× převzorkování)" }], default: 2 },
            { type: "number", key: "shard", label: "Kreseb ve studeném balíčku assetů", help: "Za běhu se nemění; horké kresby se do nich přelijí při startu serveru.", min: 1, max: 500, integer: true, default: 24 },
            { type: "number", key: "horky", label: "Kreseb v horkém balíčku", help: "Nové kresby za běhu. Po nové kresbě ho stáhne každý připojený hráč (asi 350 kB na kresbu při 1024 × 512).", min: 1, max: 24, integer: true, default: 3 },
            { type: "number", key: "reloadS", label: "Nejkratší rozestup přenačtení balíčků", min: 5, max: 3600, integer: true, unit: "s", default: 30 },
            { type: "boolean", key: "konzole", label: "Přenačítat přes konzoli playgroundu", default: true },
            { type: "slider", key: "lesk", label: "Lesk listu (Shininess)", min: 0, max: 255, step: 1, default: 30 },
            { type: "slider", key: "odsazeni", label: "List před lícem desky", min: 0, max: 30, step: 1, unit: "mm", default: 4 },
            { type: "number", key: "rozpocetMs", label: "Vykreslování smí vzít z kroku", min: 1, max: 50, integer: true, unit: "ms", default: 6 },
          ],
        },
        {
          type: "group",
          key: "limity",
          label: "Limity a kvóty",
          fields: [
            { type: "number", key: "maxPoints", label: "Bodů na kresbu", min: 100, max: 50000, integer: true, default: 15000 },
            { type: "number", key: "maxStrokes", label: "Tahů na kresbu", min: 10, max: 10000, integer: true, default: 2000 },
            { type: "number", key: "batchStrokes", label: "Tahů v dávce", min: 1, max: 200, integer: true, default: 40 },
            { type: "number", key: "batchPoints", label: "Bodů v dávce", min: 50, max: 20000, integer: true, default: 3000 },
            { type: "number", key: "itemDataMax", label: "Kresba v datech předmětu do (znaků)", min: 0, max: 16000, integer: true, default: 15000 },
            { type: "number", key: "maxBoards", label: "Desek na serveru", min: 1, max: 5000, integer: true, default: 500 },
            { type: "number", key: "maxSlots", label: "Listů na desce", min: 1, max: 48, integer: true, default: 24 },
            { type: "number", key: "dataRateKB", label: "Data kreseb na hráče", min: 8, max: 10240, integer: true, unit: "kB/s", default: 256 },
            { type: "number", key: "cacheMB", label: "Mezipaměť serveru", min: 1, max: 1024, integer: true, unit: "MB", default: 32 },
            { type: "number", key: "idleMin", label: "Kreslení bez tahu skončí po", min: 1, max: 120, integer: true, unit: "min", default: 10 },
          ],
        },
        {
          type: "group",
          key: "dosahy",
          label: "Dosahy (m)",
          fields: [
            { type: "number", key: "useRange", label: "Použít desku z", min: 1, max: 20, step: 0.5, unit: "m", default: 3.5 },
            { type: "number", key: "liveRange", label: "Cizí kreslení naživo do", min: 0, max: 200, unit: "m", default: 35 },
            { type: "number", key: "streamRange", label: "Desky v okolí hráče do", min: 10, max: 500, unit: "m", default: 60 },
          ],
        },
        {
          type: "group",
          key: "klient",
          label: "Klient",
          fields: [
            { type: "select", key: "platno", label: "Kreslicí plátno", options: [{ value: "auto", label: "Nativní, záloha HTML" }, { value: "nativni", label: "Jen nativní (Scaleform)" }, { value: "web", label: "Jen HTML" }], default: "auto" },
            { type: "string", key: "useKey", label: "Klávesa u desky", maxLength: 16, default: "f" },
            { type: "number", key: "cacheMB", label: "Mezipaměť kreseb v klientu", min: 1, max: 256, integer: true, unit: "MB", default: 8 },
            { type: "number", key: "gizmoUnits", label: "Ladicí čáry: rozpočet úseků (z 16 384)", min: 0, max: 16000, integer: true, default: 6000, showIf: { field: "/vykon.svet.rezim", ne: "textura" } },
            { type: "number", key: "gizmoIds", label: "Ladicí čáry: kreseb Gizmos (ze 128)", min: 0, max: 126, integer: true, default: 96, showIf: { field: "/vykon.svet.rezim", ne: "textura" } },
            { type: "number", key: "drawRange", label: "Ladicí čáry do (m)", min: 1, max: 100, default: 14, showIf: { field: "/vykon.svet.rezim", ne: "textura" } },
            { type: "number", key: "paperRange", label: "Ladicí listy do (m)", min: 1, max: 200, default: 40, showIf: { field: "/vykon.svet.rezim", ne: "textura" } },
          ],
        },
      ],
    },
    {
      type: "group",
      key: "vyvesky",
      label: "Vývěsky",
      fields: [
        {
          type: "list",
          key: "seznam",
          label: "Vývěsky, stojany a krámy",
          help: "Postav se před místo desky, dívej se na ni a zmáčkni „Vzít moji pozici a směr“. Smazání desky kresby nesmaže.",
          addLabel: "Přidat vývěsku",
          item: {
            type: "group",
            fields: [
              { type: "number", key: "id", label: "Číslo (nové = prázdné)", integer: true, min: 0 },
              { type: "select", key: "druh", label: "Druh", options: [{ value: "deska", label: "Vývěska" }, { value: "stojan", label: "Stojan" }, { value: "kram", label: "Krám písaře" }], default: "deska" },
              { type: "position", key: "pozice", label: "Kde stojí divák a kam se dívá", required: true },
              { type: "number", key: "vzdalenost", label: "Deska před divákem", min: 0, max: 5, step: 0.05, unit: "m", default: 0.8 },
              { type: "number", key: "vyska", label: "Střed desky nad zemí", min: -5, max: 10, step: 0.05, unit: "m", default: 1.5 },
              { type: "slider", key: "sklon", label: "Sklon líce (0 = svisle, 90 = na stole)", min: -90, max: 90, step: 1, unit: "°", default: 0 },
              { type: "number", key: "sloupce", label: "Sloupců listů", min: 1, max: 8, integer: true, default: 3, showIf: { field: "druh", eq: "deska" } },
              { type: "number", key: "radky", label: "Řádků listů", min: 1, max: 6, integer: true, default: 2, showIf: { field: "druh", eq: "deska" } },
              { type: "number", key: "sirka", label: "Šířka", min: 0.2, max: 6, step: 0.05, unit: "m", default: 1.5, showIf: { field: "druh", ne: "kram" } },
              { type: "number", key: "vyskaDesky", label: "Výška", min: 0.2, max: 4, step: 0.05, unit: "m", default: 0.75, showIf: { field: "druh", ne: "kram" } },
            ],
          },
        },
      ],
    },
    {
      type: "group",
      key: "moderace",
      label: "Moderace",
      fields: [
        { type: "select", key: "tearDown", label: "Kdo smí strhnout list", options: [{ value: "anyone", label: "Kdokoli" }, { value: "author", label: "Autor a moderátoři" }, { value: "admin", label: "Jen moderátoři" }], default: "anyone" },
        { type: "number", key: "cooldownS", label: "Pauza mezi uloženými kresbami", min: 0, max: 86400, integer: true, unit: "s", default: 60 },
        { type: "number", key: "maxVystavenych", label: "Vystavených kreseb na postavu (0 = bez omezení)", min: 0, max: 1000, integer: true, default: 0 },
        { type: "list", key: "zakazanaSlova", label: "Zakázaná slova v názvu kresby", item: { type: "string", maxLength: 40 } },
      ],
    },
  ];
}

export function def(): SettingsDef<Player> {
  return {
    id: "kresby",
    title: "Kresby: inkousty, materiály, nástroje, vývěsky",
    perm: "kresby.admin",
    schema: schema(),
    get: () => value(),
    set: (v, ctx) => set(v, ctx.caller ?? null),
    reset: () => reset(),
    preview: ({ value: v, path }) => {
      if (path[0] === "vyvesky" && typeof path[2] === "number") {
        const b = (v as any).vyvesky?.seznam?.[path[2]];
        if (!b) return { message: "Vyber vývěsku." };
        const f = valueToFace(b);
        return { message: `Střed desky ${f.pos.map((x) => x.toFixed(2)).join(" ")}, líc hledí ${f.n.map((x) => x.toFixed(2)).join(" ")}.` };
      }
      return { message: "Hodnoty jsou v pořádku. Uložením se hned použijí." };
    },
  };
}

/** pošle nastavení správě (když běží); správa si ho jinak vezme z exportu spravaSettings */
export function push(): boolean {
  try {
    const f = Exports.get("sprava", "registerSettings");
    if (typeof f !== "function") return false;
    (f as (d: unknown, o: string) => unknown)(def(), "kresby");
    log("nastavení je v editoru správy (F10, /kresby nastaveni)");
    return true;
  } catch (e) {
    log("nastavení do správy: " + String(e));
    return false;
  }
}

/** /kresby nastaveni [cesta]: otevře editor ve správě */
export async function open(p: Player, path?: string): Promise<boolean> {
  try {
    const f = Exports.get("sprava", "open");
    if (typeof f !== "function") return false;
    return !!(await (f as (id: number, o: unknown) => unknown)(p.id, { settings: "kresby", path: path || undefined }));
  } catch {
    return false;
  }
}

export const _test = { apply, value, boardToValue, valueToFace, reset };
