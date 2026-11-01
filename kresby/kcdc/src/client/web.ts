// Záložní HTML plátno (CEF web view) - jen když nativní Scaleform kreslit neumí (client/native.ts, zkouška při
// otevření) nebo když to server nastaví (KRESBY_CONFIG.klient.platno = "web"). Stránka je ui/platno.html,
// její skript ui/platno.js se staví ze src/web/platno.ts a kreslí stejným vektorovým kódem jako zbytek modulu
// (src/shared/vector.ts), navíc s násobením průhledných inkoustů (canvas "multiply") a rastrem papíru.
//
// Most stránka <-> skript: stránka callEvent(jméno, JSON), skript Web.emit(view, jméno, data) = CustomEvent
// na window (docs KCDC "Page data bridge").

import { encodeK3, type Drawing } from "../shared/codec";
import type { ViewMsg } from "../shared/protocol";
import type { CanvasApi, CanvasBackend, ViewerBackend } from "./hooks";

const URL = "fw://resources/kresby/ui/platno.html";
const log = (t: string) => console.log("[kresby] " + t);

let view: number | null = null;
let ready = false;
let queue: [string, unknown][] = [];
let api: CanvasApi | null = null;
let mode: "canvas" | "view" | null = null;
let onViewClose: (() => void) | null = null;

function ensure(): boolean {
  if (view !== null) return true;
  try {
    const s = Web.getScreenSize();
    view = Web.createView(URL, { x: 0, y: 0, width: s.width, height: s.height, visible: false, zIndex: 50 });
  } catch (e) {
    log("web view: " + String(e));
    view = null;
    return false;
  }
  Events.on("browserDocumentReady", (e: unknown) => {
    if ((e as { viewId?: number })?.viewId !== view) return;
    ready = true;
    const q = queue;
    queue = [];
    for (const [n, p] of q) Web.emit(view!, n, p);
  });
  Events.on("browserLoadingFailed", (e: unknown) => {
    if ((e as { viewId?: number })?.viewId === view) log("platno.html se nenačetla");
  });
  const on = (name: string, f: (p: any) => void) => Web.on(view!, name, (p: unknown) => {
    try {
      f(p);
    } catch (e) {
      log(`stránka ${name}: ${String(e)}`);
    }
  });
  on("kresby:stroke", (p) => {
    if (!api || !p || !Array.isArray(p.p)) return;
    if (p.brush) Object.assign(api.brush, p.brush);
    const why = api.addStroke(p.p);
    send("kresby:result", { why, ...state() });
  });
  on("kresby:brush", (p) => api && p && Object.assign(api.brush, p));
  on("kresby:undo", () => api?.undo());
  on("kresby:finish", (p) => api?.finish(String(p?.title ?? "")));
  on("kresby:cancel", () => api?.cancel());
  on("kresby:close", () => {
    if (mode === "view") {
      hide();
      const cb = onViewClose;
      onViewClose = null;
      cb?.();
    }
  });
  return true;
}

function send(name: string, payload: unknown) {
  if (view === null) return;
  if (ready) Web.emit(view, name, payload);
  else queue.push([name, payload]);
}

function state() {
  return api ? { drops: api.drops(), charcoal: api.charcoal(), status: api.status(), count: api.strokes.length } : {};
}

function show() {
  if (view === null) return;
  Web.showView(view);
  Web.focusView(view, true);
}

function hide() {
  if (view === null) return;
  Web.focusView(view, false); // schovaná stránka by jinak držela vstup
  Web.hideView(view);
}

export const webCanvas: CanvasBackend = {
  open(a: CanvasApi) {
    if (!ensure()) return false;
    api = a;
    mode = "canvas";
    send("kresby:canvas", { msg: a.msg, d: encodeK3(a.drawing()), brush: a.brush, ...state() });
    a.onChange(() => send("kresby:state", { d: encodeK3(a.drawing()), ...state() }));
    show();
    return true;
  },
  hide,
  close() {
    api = null;
    mode = null;
    hide();
  },
};

export const webViewer: ViewerBackend & { onClose: (() => void) | null } = {
  onClose: null,
  open(v: ViewMsg, d: Drawing) {
    if (!ensure()) return false;
    mode = "view";
    onViewClose = () => webViewer.onClose?.();
    send("kresby:view", { title: v.title, author: v.author, d: encodeK3(d) });
    show();
    return true;
  },
  close() {
    mode = null;
    hide();
  },
};
