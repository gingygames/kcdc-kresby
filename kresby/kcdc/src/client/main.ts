// Kresby - klientská část pro Kingdoms Connected (KCDC).
//
// * ve světě: kresby na vývěskách a stojanech jako 3D čáry (client/world.ts, Gizmos) s LOD a rozpočtem;
// * u desky: nápověda akce hry (ActionHint) na klávese CFG.klient.useKey -> server otevře nabídku (herní dialog);
// * kreslení: kamera se zamkne na list (Camera.setShot), plátno leží přes list - nativně ve Scaleformu
//   (client/native.ts), když to nejde, HTML (client/web.ts); jiný UI framework si backend vymění (client/hooks.ts);
// * prohlížení kresby: stejné backendy; kniha o barvách: nativní kniha hry v rukou (Book).

import type { Drawing } from "../shared/codec";
import { EV, type AckMsg, type BoardMsg, type CanvasMsg, type DataMsg, type LiveMsg, type OkoliMsg, type ViewMsg } from "../shared/protocol";
import { custom, setUi, type CanvasBackend, type ViewerBackend } from "./hooks";
import { nativeViewer } from "./native";
import { nativeCanvas } from "./platno";
import { CanvasSession } from "./session";
import { webCanvas, webViewer } from "./web";
import * as world from "./world";
import { emitServer, listen, useMost } from "./net";
import { setLook, type Look } from "../shared/look";
import { captionOwnerStopped, setCaptionFilter } from "../shared/popisky";

const log = (t: string) => console.log("[kresby] " + t);
const safe = <A extends unknown[]>(name: string, f: (...a: A) => unknown) => (...a: unknown[]) => {
  try {
    const r = f(...(a as A));
    if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).catch((e) => log(`${name}: ${String(e)}`));
  } catch (e) {
    log(`${name}: ${String(e)}`);
  }
};

let session: CanvasSession | null = null;
let backend: CanvasBackend | null = null;
let viewer: ViewerBackend | null = null;
let shot = false;

// ---------------------------------------------------------------------------
// kreslení

function canvasChain(): CanvasBackend[] {
  const out: CanvasBackend[] = [];
  if (custom.canvas) out.push(custom.canvas);
  if (world.cfg.platno !== "web") out.push(nativeCanvas);
  if (world.cfg.platno !== "nativni") out.push(webCanvas);
  return out;
}

function closeCanvas(clearCamera: boolean) {
  backend?.close();
  backend = null;
  session?.stop();
  if (clearCamera && shot) session?.clearShot();
  if (clearCamera) shot = false;
  session = null;
  world.setOwnSlot(null);
}

async function openCanvas(m: CanvasMsg) {
  const resume = session?.msg.s === m.s;
  closeCanvas(!resume);
  const s = new CanvasSession(m);
  session = s;
  world.setOwnSlot(m.b, m.slot);
  if (!shot) shot = s.shot();
  const finish = s.finish.bind(s);
  s.finish = (title: string) => {
    finish(title);
    backend?.hide?.(); // server ukáže dialog: nechat viset / vzít s sebou
  };
  for (const b of canvasChain()) {
    let ok = false;
    try {
      ok = await b.open(s);
    } catch (e) {
      log("plátno: " + String(e));
    }
    if (session !== s) return b.close();
    if (ok) {
      backend = b;
      return;
    }
  }
  emitServer(EV.platnoChyba, { s: m.s, why: "žádné plátno (Scaleform ani web view)" });
  closeCanvas(true);
}

listen(EV.platno, safe("platno", (m: CanvasMsg) => openCanvas(m)));
listen(EV.ack, safe("ack", (m: AckMsg) => session?.msg.s === m.s && session.onAck(m)));
listen(EV.zavrit, safe("zavrit", (m: { s: number; why?: string }) => {
  if (session?.msg.s !== m.s) return;
  closeCanvas(true);
  if (m.why) Hud.showNotification(m.why);
}));

// ---------------------------------------------------------------------------
// prohlížení

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// čtení na desce: kamera na list. Když hráč texturu kresby má (Prop s modelem kresby), čte se přímo ve světě
// (osvětlený list, nic přes něj); jinak se kresba ukáže přes list nativním prohlížečem.
let reading: { end: () => void } | null = null;
const GLIDE = 700; // ms přeletu kamery na list a zpět

function stopReading() {
  const r = reading;
  reading = null;
  r?.end();
}

async function readOnBoard(m: ViewMsg, d: Drawing): Promise<boolean> {
  const pose = Camera.getPose();
  const shot = pose && world.sheetShot(m.board!, m.slot ?? 0, pose.fov || 55, pose.aspectRatio || 16 / 9);
  if (!shot) return false;
  try {
    // plynulý přelet na list (ne střih); hráč se během něj nehýbe
    Camera.setShot({ position: new Vector3(shot.eye[0], shot.eye[1], shot.eye[2]), lookAt: new Vector3(shot.at[0], shot.at[1], shot.at[2]), duration: GLIDE });
  } catch {
    return false;
  }
  Controls.disable();
  const hasTexture = world.cfg.rezim !== "cary" && !!m.o && m.id !== undefined && Assets.has(`textures/kcdc/${m.o}/k${m.id}.dds`);
  // textura kresby u hráče ještě není (nová kresba, balíček se přenačítá): list ve světě má přesýpací hodiny
  const loading = world.cfg.rezim !== "cary" && !hasTexture;
  const keys = ["escape", "e", "f", "w", "s", "a", "d"];
  const end = () => {
    for (const k of keys) {
      try {
        Key.unbind(k, "down", leave);
      } catch {
        /* neznámá klávesa */
      }
    }
    // nejdřív pryč s překryvem, pak plynule zpět do očí; ovládání až po dojezdu (klávesa, kterou hráč odešel,
    // ani pohyb myši s postavou během přeletu necuknou)
    viewer?.close();
    viewer = null;
    Hud.hideInfoText();
    Camera.clearShot(GLIDE);
    setTimeout(() => Controls.enable(), GLIDE);
  };
  const leave = () => {
    if (reading?.end === end) stopReading();
  };
  stopReading();
  reading = { end };
  await sleep(GLIDE); // kamera dojede, klávesa, kterou se čtení otevřelo, je pustěná
  if (reading?.end !== end) return true;
  for (const k of keys) {
    try {
      Key.bind(k, "down", leave);
    } catch {
      /* neznámá klávesa */
    }
  }
  Hud.showInfoText(`„${m.title}“${m.author ? " – " + m.author : ""}${loading ? "  (kresba se ve světě ještě načítá, ukazuji náhled)" : ""}   ·   Esc nebo pohyb: zpět`, 600000);
  if (!hasTexture) {
    // textura ještě není u hráče (nová kresba, balíček se přenačítá) nebo ladicí režim: kresba přes list
    for (const v of viewerChain()) {
      try {
        if (await v.open({ ...m, loading: true }, d)) {
          viewer = v;
          (v as { onClose?: (() => void) | null }).onClose = () => leave();
          break;
        }
      } catch (e) {
        log("prohlížení: " + String(e));
      }
    }
  }
  return true;
}

function viewerChain(): ViewerBackend[] {
  const chain: ViewerBackend[] = [];
  if (custom.viewer) chain.push(custom.viewer);
  if (world.cfg.platno !== "web") chain.push(nativeViewer);
  if (world.cfg.platno !== "nativni") chain.push(webViewer);
  return chain;
}

async function view(m: ViewMsg) {
  const d: Drawing | null = world.put(m.h, m.d);
  if (!d) return void Hud.showNotification("Kresba je rozmazaná, nejde rozeznat.");
  viewer?.close();
  viewer = null;
  if (m.board !== undefined && !session && (await readOnBoard(m, d))) return;
  if (m.inv) {
    // z inventáře: menu hry by prohlížeč překrylo (bylo vidět jen inventář) - zavřít ho a počkat, až zmizí
    try {
      NativeUI.setMenuEnabled("inventory", false);
      await sleep(150);
      NativeUI.setMenuEnabled("inventory", true);
    } catch (e) {
      log("zavření inventáře: " + String(e));
    }
    await sleep(250);
  }
  for (const v of viewerChain()) {
    try {
      if (await v.open(m, d)) return void (viewer = v);
    } catch (e) {
      log("prohlížení: " + String(e));
    }
  }
}

listen(EV.prohlizet, safe("prohlizet", (m: ViewMsg) => view(m)));

// ---------------------------------------------------------------------------
// svět

listen(EV.okoli, safe("okoli", (m: OkoliMsg & { cfg?: Partial<world.ClientCfg> }) => {
  if (m.cfg) {
    const { vzhled, ...rest } = m.cfg as Partial<world.ClientCfg> & { vzhled?: Partial<Look> };
    Object.assign(world.cfg, rest);
    if (vzhled) setLook(vzhled);
  }
  world.onOkoli(m);
}));
listen(EV.deska, safe("deska", (m: BoardMsg) => world.onDeska(m)));
listen(EV.data, safe("data", (m: DataMsg) => world.onData(m)));
listen(EV.zive, safe("zive", (m: LiveMsg) => world.onLive(m)));
listen(EV.ladit, safe("ladit", (m: { ms?: number }) => world.outlines(m?.ms ?? 60000)));
listen(EV.info, safe("info", (m: { text?: string }) => m?.text && Hud.showNotification(m.text)));
listen(EV.kniha, safe("kniha", (m: { pages?: string[] }) => {
  if (!Array.isArray(m?.pages) || Book.getOpenBook() !== null) return;
  if (Book.open({ pages: m.pages, style: "book", visual: 4 }) === null) Hud.showNotification("Knihu teď otevřít nejde: " + Book.getLastError());
}));

// nápověda akce u desky
let hint: number | null = null;
let hintText = "";
let hintBroken = false;
let hintAt = 0;
let aimed: world.Target | null = null;

function use() {
  if (aimed && !session && !Hud.isInDialogue()) emitServer(EV.pouzit, { b: aimed.b, slot: aimed.slot });
}

function updateHint() {
  aimed = session || Hud.isInDialogue() ? null : world.target();
  if (!aimed) {
    if (hint !== null) ActionHint.remove(hint);
    if (hintBroken && hintText) Hud.hideInfoText();
    hint = null;
    hintText = "";
    return;
  }
  if (hintBroken) {
    // infotext drží jen chvíli: obnovovat, dokud se hráč na desku dívá
    if (aimed.text !== hintText || Date.now() - hintAt > 700) {
      hintText = aimed.text;
      hintAt = Date.now();
      Hud.showInfoText(`[${Key.getLabel(world.cfg.useKey)}] ${aimed.text}`, 1000);
    }
    return;
  }
  if (aimed.text === hintText && hint !== null) return;
  hintText = aimed.text;
  if (hint !== null && ActionHint.setText(hint, aimed.text)) return;
  try {
    if (!ActionHint.keys().includes(world.cfg.useKey)) throw new Error("klávesa není v ActionHint.keys()");
    hint = ActionHint.create({ key: world.cfg.useKey, text: aimed.text }, () => use());
  } catch (e) {
    // klávesa není mezi ActionHint.keys(): obyčejná klávesa + infotext
    log(`nápověda akce na "${world.cfg.useKey}": ${String(e)}`);
    hintBroken = true;
    try {
      Key.bind(world.cfg.useKey, () => use());
    } catch (e2) {
      log("klávesa: " + String(e2));
    }
  }
}

const timers = [setInterval(safe("vykreslení", world.render), 250), setInterval(safe("nápověda", updateHint), 200)];

// posluchači se u mostu registrují v listen(); po (re)startu mostu znovu
Events.on("resourceStart", safe("start", (name: string) => name === "most" && useMost()));

Events.on("resourceStop", safe("stop", (name: string) => {
  captionOwnerStopped(name);
  if (name !== "kresby") return;
  stopReading(); // kamera na listu a infotext na 600 s by jinak zastavení resource přežily
  for (const t of timers) clearInterval(t);
  closeCanvas(true);
  viewer?.close();
  if (hint !== null) ActionHint.remove(hint);
  world.clearAll();
}));

// API pro ostatní klientské resources
Exports.register("setUi", setUi);
Exports.register("setCaptionFilter", setCaptionFilter); // popisky (nápověda „Prohlédnout …“) podle gramotnosti (škola)
Exports.register("isDrawing", () => !!session);
Exports.register("stats", () => ({ ...world.stats }));
