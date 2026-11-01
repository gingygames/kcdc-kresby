// Háčky UI kreseb v klientu: kreslicí plátno a prohlížení kresby jdou přes vyměnitelné "backendy".
//
// Výchozí backendy jsou dva: nativní (Scaleform obrazovka hry, client/native.ts) a HTML (CEF, client/web.ts,
// jen když nativní nejde). Jiný UI framework si je vymění z vlastního klientského resource:
//
//   const setUi = Exports.get("kresby", "setUi") as (ui: Partial<KresbyUi>) => void;
//   setUi({ canvas: mojePlatno, viewer: mujProhlizec });     // null / vynechané = výchozí
//
// Backend dostane CanvasApi: stav relace (nástroj, inkousty, zbývající kapky, tahy) a akce (addStroke, undo,
// finish, cancel). Pravidla (spotřeba, limity, potvrzování serverem, kamera na list) drží CanvasApi - backend jen
// kreslí a sbírá vstup. Viz AGENTS.md, "Vlastní UI".

import type { Drawing, Stroke } from "../shared/codec";
import type { CanvasMsg, ViewMsg } from "../shared/protocol";

export interface Brush {
  tool: number; // 0 brk, 1 štětec, 2 uhel, 3 škrabka
  a: number; // inkoust od 1 (0 = žádný)
  b: number; // přimíchaný inkoust (0 = žádný)
  mix: number; // podíl b 0..255
  size: number; // čtvrtpixely 2..160 (0,5..40 px)
  op: number; // krytí 13..255
}

export interface CanvasApi {
  readonly msg: CanvasMsg;
  /** všechny tahy listu v pořadí (přijaté serverem i čekající) */
  readonly strokes: Stroke[];
  brush: Brush;
  /** zbývající kapky po inkoustech (odhad do potvrzení serverem), uhel v px² */
  drops(): number[];
  charcoal(): number;
  /** papír, inkousty a tahy jako kresba (pro vykreslení) */
  drawing(): Drawing;
  /** nový tah (x, y, přítlak 0..15 po trojicích, logické px 768 × 512): null = přijat, jinak proč ne */
  addStroke(p: number[], brush?: Brush): string | null;
  /** znovu tah vzatý zpět (null = vrácen, jinak proč ne) */
  redo?(): string | null;
  canRedo?(): boolean;
  /** kolik tahů server ještě nepotvrdil; finishing = ukládá se hotová kresba */
  saveState?(): { pending: number; finishing: boolean };
  undo(): void;
  /** hotovo: server se zeptá, jestli nechat viset nebo vzít s sebou */
  finish(title: string): void;
  cancel(): void;
  /** backend chce vědět o změnách stavu (potvrzení, odmítnutý tah, zpět) */
  onChange(cb: (why: "ack" | "reject" | "undo" | "reset") => void): void;
  /** stavová zpráva pro hráče (došel inkoust …) */
  status(): string;
  /** rohy listu ve světě (levý horní, pravý dolní), když je kamera na listu - pro obdélník plátna na obrazovce */
  corners?(): [[number, number, number], [number, number, number]];
}

export interface CanvasBackend {
  /** otevře plátno; false = neumí (zkusí se další backend) */
  open(api: CanvasApi): boolean | Promise<boolean>;
  close(): void;
  /** dočasně schovat (dialog dokončení), znovu ukázat */
  hide?(): void;
}

export interface ViewerBackend {
  open(view: ViewMsg, drawing: Drawing): boolean | Promise<boolean>;
  close(): void;
}

export interface KresbyUi {
  canvas: CanvasBackend | null;
  viewer: ViewerBackend | null;
}

export const custom: KresbyUi = { canvas: null, viewer: null };

export function setUi(ui: Partial<KresbyUi>) {
  if ("canvas" in ui) custom.canvas = ui.canvas ?? null;
  if ("viewer" in ui) custom.viewer = ui.viewer ?? null;
}
