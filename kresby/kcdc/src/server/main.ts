// Kresby - serverová část pro Kingdoms Connected (KCDC).
//
// Hráčské kresby na pergamen a papír: kreslí se u vývěsky nebo stojanu ve světě, ostatní kreslení vidí naživo,
// hotová kresba visí na vývěsce (všichni ji vidí ve světě) nebo jde do brašny jako předmět. Inkousty jsou
// předměty s kapkami, míchají se a ředí v knize o barvách, papír a nástroje prodává písař (obchod hry).
//
// Nastavení: globalThis.KRESBY_CONFIG v kresby_config.js (načte se před server.js).
// Napojení na framework serveru: resource "most" (server/most.ts), admin UI: resource "sprava" (server/admin.ts).

import * as net from "./net";
import { EV } from "../shared/protocol";
import { command, info, panels } from "./admin";
import { registerApi } from "./api";
import { captionOwnerStopped, setCaptionFilter } from "../shared/popisky";
import * as assets from "./assets";
import { changed, destroyProps, forget, indexAll, liveAt, streamAll, stream } from "./boards";
import * as sheets from "./props";
import * as settings from "./settings";
import { CFG } from "./config";
import { forgetPlayer, serveData, useBoard, viewItem } from "./drawings";
import { ITEM, adminGive, kindOf, onVendorTrade, openBook, registerItems } from "./materials";
import * as most from "./most";
import { endAll, flushLive, onCancel, onCanvasError, onDisconnect, onFinish, onStrokes, onUndo, sessionOfPlayer, watchdog } from "./sessions";
import { storage } from "./most";
import { boards, flush, getDrawing, load } from "./store";

const log = (t: string) => console.log("[kresby] " + t);
const RESOURCE = "kresby";
let started = false;
let loadedFrom = "";
const timers: ReturnType<typeof setInterval>[] = [];

function guard<A extends any[]>(name: string, f: (...a: A) => unknown): (...a: any[]) => void {
  return (...a: any[]) => {
    try {
      const r = f(...(a as A));
      if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).catch((e) => log(`${name}: ${String(e)}`));
    } catch (e) {
      log(`${name}: ${String(e)}`);
    }
  };
}

async function boot() {
  if (started) return;
  started = true;
  const found = most.resolveBridges();
  await settings.load(); // nastavení ze správy (inkousty, papíry, ceny …) před registrací předmětů
  registerItems();
  await load();
  loadedFrom = storage.kind();
  await assets.init({ onLive: refreshLive, drawing: async (id) => getDrawing(id), players: () => Player.all().length });
  indexAll();
  // chybějící textury: po kouscích ve frontě; při startu bez hráčů rovnou do studených balíčků
  for (const b of boards.values()) for (const s of b.slots) if (s && !s.hid) void assets.want(s.d, { start: true });
  if (found.sprava && most.registerPanel(panels()[0])) log("panel ve správě zaregistrován");
  if (found.sprava) settings.push();
  timers.push(setInterval(guard("okolí", streamAll), CFG.streamMs));
  timers.push(setInterval(guard("živě", flushLive), 150));
  timers.push(setInterval(guard("hlídání", watchdog), 5000));
  timers.push(setInterval(guard("listy", () => sheets.retryFailed((id) => boards.get(id), (b, slot) => liveAt(b, slot) > 0)), 3000));
  log(`běží: ${most.mostInfo()}, úložiště ${loadedFrom}`);
}

/**
 * Balíček textur běží s novými soubory: listy ve světě vyměnit a klientům říct, kde textura je. Zprávu dostanou jen
 * desky s kresbou, která právě přestala čekat (dřív všechny desky všem, kdo o nich vědí, po každém přenačtení).
 * Prázdné listy (balíček 0) mění jen Prop na serveru, klientům se nic neposílá.
 */
function refreshLive(shard: string, ids: number[]) {
  const live = new Set(ids);
  const blank = shard === assets.blankShard();
  for (const b of boards.values()) {
    if (b.slots.some((s) => s && live.has(s.d))) changed(b, false);
    else if (blank) sheets.sync(b, (slot) => liveAt(b, slot) > 0);
  }
}

Events.on("resourceStart", guard("start", async (name: unknown) => {
  if (name === RESOURCE) return boot();
  if (typeof name === "string" && started) assets.onResourceStart(name);
  if (name === "most") net.mostStarted();
  if (name === "most" || name === "sprava") {
    const found = most.resolveBridges();
    if (name === "sprava") {
      if (found.sprava) most.registerPanel(panels()[0]);
      if (!settings.push()) setTimeout(() => settings.push(), 1000); // exporty správy ještě nemusí být
    }
    // most přišel až po nás: desky načíst z jeho úložiště (do té doby byly jen v paměti)
    if (name === "most" && started && loadedFrom === "pamet" && storage.kind() === "most") {
      await load();
      loadedFrom = storage.kind();
      indexAll();
      streamAll();
      log("úložiště mostu připojeno, desky načteny znovu");
    }
  }
}));

Events.on("resourceStop", guard("stop", async (name: unknown) => {
  if (typeof name === "string") captionOwnerStopped(name);
  if (name === "most" || name === "sprava") return void most.resolveBridges();
  if (name !== RESOURCE) return;
  for (const t of timers) clearInterval(t);
  endAll();
  destroyProps();
  sheets.destroyAll();
  await flush();
}));

Events.on("playerReady", guard("playerReady", (p: Player) => stream(p)));

Events.on("playerDisconnect", guard("odpojení", (p: Player) => {
  onDisconnect(p);
  most.closeMenus(p);
  net.forget(p);
  forget(p);
  forgetPlayer(p);
}));

Events.on("playerCommand", guard("příkaz", (p: Player, cmd: string, args: string[]) => {
  if (cmd.toLowerCase() === CFG.command) return command(p, args ?? []);
}));

// konzole serveru: "kresby info" (stav, listy ve světě, textury)
Events.on("consoleCommand", guard("konzole", (cmd: string, args: string[]) => {
  if (String(cmd).toLowerCase() !== CFG.command) return;
  if ((args?.[0] ?? "info") === "info") for (const line of info().split(String.fromCharCode(10))) log(line);
}));

Events.on("dialogueChoice", guard("dialog", (s: number, p: Player, id: string) => most.onDialogueChoice(s, p, id)));
Events.on("dialogueClosed", guard("dialog", (s: number) => most.onDialogueClosed(s)));
Events.on("vendorTrade", guard("krám", (v: number) => onVendorTrade(v)));

Events.on("playerCustomItemUse", guard("předmět", (p: Player, row: InventoryRow) => {
  const k = kindOf(row);
  if (k === ITEM.kresba) return viewItem(p, row);
  if (k === ITEM.kniha) return openBook(p);
}));

net.onClient(EV.chci, guard("chci", (p: Player, m: any) => serveData(p, m)));
net.onClient(EV.pouzit, guard("použít", (p: Player, m: any) => useBoard(p, m)));
net.onClient(EV.tahy, guard("tahy", (p: Player, m: any) => onStrokes(p, m)));
net.onClient(EV.zpet, guard("zpět", (p: Player, m: any) => onUndo(p, m)));
net.onClient(EV.hotovo, guard("hotovo", (p: Player, m: any) => onFinish(p, m)));
net.onClient(EV.konec, guard("konec", (p: Player, m: any) => onCancel(p, m)));
net.onClient(EV.platnoChyba, guard("plátno", (p: Player, m: any) => onCanvasError(p, m)));

// API pro ostatní resources (manifest exports)
Exports.register("isBusy", (playerId: number) => {
  const p = Player.getById(playerId);
  return !!(p && sessionOfPlayer(p));
});
Exports.register("giveMaterial", (playerId: number, what: string, arg?: string) => {
  const p = Player.getById(playerId);
  return p ? adminGive(p, what, arg) : Promise.resolve("Hráč není připojený.");
});
Exports.register("spravaPanels", () => panels());
Exports.register("spravaSettings", () => settings.def());
registerApi(); // desky a kreslení pro jiné resources (škola)
Exports.register("setCaptionFilter", setCaptionFilter); // popisky kreseb podle gramotnosti (škola)
