// Nativní UI kreseb: obrazovka Scaleform hry (NativeUI.createScreen) a kreslicí API movie clipu
// (lineStyle / moveTo / lineTo / curveTo / beginFill / endFill / clear přes clip.invoke, docs KCDC "Native UI").
//
// Plátno leží na obrazovce přesně přes list ve světě (kamera je zamčená na list, rohy se promítnou přes
// Hud.worldToScreen), takže hráč kreslí "na vývěsku". Když promítnutí nevyjde, je list uprostřed obrazovky.
// Myš: clip.get("_xmouse"/"_ymouse") po 16 ms během tahu (AS2 vlastnosti, docs je neuvádějí - ověřuje
// se zkouškou při otevření; když nefungují, open() vrátí false a klient zkusí HTML plátno).

import { TOOL, SRC_H, SRC_W, type Drawing, type Stroke } from "../shared/codec";
import { paperOf, PRESSURE, rgbInt, mixRGB, type RGB } from "../shared/ink";
import { drawingOps, hash, strokeOps, type Ops } from "../shared/vector";
import type { ViewMsg } from "../shared/protocol";
import type { ViewerBackend } from "./hooks";
import { btn } from "./widgets";

const log = (t: string) => console.log("[kresby] " + t);

// ---------------------------------------------------------------------------
// kreslení do clipu

export class Pen {
  private style = "";
  calls = 0;
  constructor(readonly c: NativeClip) {}
  private i(m: string, a: (number | string | boolean | null)[]) {
    this.calls++;
    return this.c.invoke(m, a);
  }
  clear() {
    this.i("clear", []);
    this.style = "";
  }
  line(w: number, rgb: number, a: number) {
    const k = w + ":" + rgb + ":" + a;
    if (k === this.style) return;
    this.style = k;
    this.i("lineStyle", [w, rgb, a]);
  }
  noLine() {
    if (this.style === "-") return;
    this.style = "-";
    this.i("lineStyle", []);
  }
  move(x: number, y: number) {
    this.i("moveTo", [x, y]);
  }
  to(x: number, y: number) {
    this.i("lineTo", [x, y]);
  }
  rect(x: number, y: number, w: number, h: number, rgb: number, a = 100) {
    this.noLine();
    this.i("beginFill", [rgb, a]);
    this.move(x, y);
    this.to(x + w, y);
    this.to(x + w, y + h);
    this.to(x, y + h);
    this.to(x, y);
    this.i("endFill", []);
  }
  frame(x: number, y: number, w: number, h: number, t: number, rgb: number, a: number) {
    this.line(t, rgb, a);
    this.move(x, y);
    this.to(x + w, y);
    this.to(x + w, y + h);
    this.to(x, y + h);
    this.to(x, y);
  }
  circle(cx: number, cy: number, r: number, rgb: number, a: number) {
    this.noLine();
    this.i("beginFill", [rgb, a]);
    const k = r / Math.cos(Math.PI / 8);
    this.move(cx + r, cy);
    for (let i = 1; i <= 8; i++) {
      const a1 = (i * Math.PI) / 4;
      const am = a1 - Math.PI / 8;
      this.i("curveTo", [cx + Math.cos(am) * k, cy + Math.sin(am) * k, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r]);
    }
    this.i("endFill", []);
  }
}

/** pergamen / papír 768 × 512 (logické px): podklad, skvrny, ztmavlé okraje, u papíru žebrování */
export function drawPaper(pen: Pen, paper: number) {
  const base = paperOf(paper).rgb;
  pen.rect(0, 0, SRC_W, SRC_H, rgbInt(base));
  const dark = rgbInt([base[0] * 0.72, base[1] * 0.66, base[2] * 0.55].map(Math.round) as RGB);
  if (paper === 1) {
    for (let x = 55; x < SRC_W; x += 110) {
      pen.line(1.5, dark, 7);
      pen.move(x, 0);
      pen.to(x, SRC_H);
    }
  } else {
    for (let i = 0; i < 14; i++) {
      const x = 30 + hash(i, 2, 7) * (SRC_W - 60);
      const y = 30 + hash(i, 3, 7) * (SRC_H - 60);
      const r = Math.min(40 + hash(i, 1, 7) * 90, x, SRC_W - x, y, SRC_H - y); // skvrna nepřeteče přes okraj listu
      pen.circle(x, y, r, dark, 3 + Math.round(hash(i, 4, 7) * 3));
    }
  }
  for (let i = 0; i < 6; i++) pen.frame(i * 7, i * 7, SRC_W - i * 14, SRC_H - i * 14, 14, dark, 9 - i);
}

/**
 * Šířka čáry: do 1 px po čtvrtinách, výš po stupních ~12 % (2^(1/6)). Přítlak mění šířku plynule a každá jiná
 * šířka je volání lineStyle navíc; dřív (po 0,25 px) to bylo skoro u každého segmentu.
 */
export const qW = (w: number) => (w <= 1 ? Math.max(0.5, Math.round(w * 4) / 4) : Math.round(2 ** (Math.round(Math.log2(w) * 6) / 6) * 8) / 8);
export const qA = (a: number) => Math.max(1, Math.min(100, Math.round(a * 25) * 4));

/**
 * Vykreslování po kouscích: tahy se kreslí v dávkách po `budget` voláních na snímek, ať hra nezaškobrtne
 * ani u kresby s tisíci segmenty.
 */
export class Painter {
  private queue: { ops: Ops; pen: Pen }[] = [];
  private run = 0;
  private seg = 0;
  private dot = 0;
  private timer: number | null = null;
  constructor(private pen: Pen, private paper: number, private budget = 1500) {}

  /** tahy do fronty; pen = do kterého clipu (výchozí ten z konstruktoru) */
  add(ops: Ops, pen = this.pen) {
    this.queue.push({ ops, pen });
    this.kick();
  }
  reset(ops: Ops) {
    this.queue = [{ ops, pen: this.pen }];
    this.run = this.seg = this.dot = 0;
    this.pen.clear();
    this.kick();
  }
  /** zahodit, co čeká na kreslení do clipu pen (clip se maže) */
  drop(pen: Pen) {
    if (this.queue[0]?.pen === pen) this.run = this.seg = this.dot = 0;
    this.queue = this.queue.filter((q) => q.pen !== pen);
    if (!this.queue.length) this.stop();
  }
  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
  get busy() {
    return this.queue.length > 0;
  }
  private kick() {
    if (this.timer !== null) return;
    this.step();
    if (this.queue.length) this.timer = setInterval(() => this.step(), 16);
  }
  /** jedna dávka; vrátí true, když je hotovo */
  step(): boolean {
    let n = 0;
    while (this.queue.length && n < this.budget) {
      const { ops, pen } = this.queue[0];
      if (this.run < ops.runs.length) {
        const r = ops.runs[this.run];
        const pts = r.pts;
        const color = r.mode === 2 ? rgbInt(paperOf(this.paper).rgb) : r.color;
        if (this.seg === 0) {
          pen.line(qW(r.w[0] ?? 1), color, qA(r.a[0] ?? 1));
          pen.move(pts[0], pts[1]);
          n += 2;
        }
        while (this.seg < r.w.length && n < this.budget) {
          const i = this.seg;
          pen.line(qW(r.w[i]), color, qA(r.a[i]));
          pen.to(pts[i * 2 + 2], pts[i * 2 + 3]);
          this.seg++;
          n += 2;
        }
        if (this.seg >= r.w.length) {
          this.run++;
          this.seg = 0;
        }
      } else if (this.dot < ops.dots.length) {
        const d = ops.dots[this.dot++];
        pen.circle(d.x, d.y, Math.max(0.4, d.r), d.color, qA(d.alpha));
        n += 12;
      } else {
        this.queue.shift();
        this.run = this.seg = this.dot = 0;
      }
    }
    if (!this.queue.length) this.stop();
    return !this.queue.length;
  }
}

/**
 * Hotové tahy plátna po blocích: `size` tahů = jeden podřízený clip. Zpět, znovu nebo odmítnutý tah smaže
 * a překreslí jen bloky od prvního změněného tahu (dřív celé plátno: u plné kresby ~40 000 volání = 27 snímků
 * s blikáním). Nové tahy se jen přidají do posledního bloku.
 */
export class StrokeBlocks {
  private blocks: { pen: Pen; drawn: Stroke[] }[] = [];
  /** kolik tahů se při posledním sync smazalo a kreslí znovu (měření, testy) */
  redrawn = 0;
  constructor(private parent: NativeClip, private painter: Painter, private size = 32) {}

  get count() {
    return this.blocks.reduce((n, b) => n + b.drawn.length, 0);
  }

  sync(d: Drawing) {
    const s = d.strokes;
    const had = this.count;
    let same = 0; // shodný začátek (tytéž objekty tahů)
    outer: for (const b of this.blocks) {
      for (const x of b.drawn) {
        if (s[same] !== x) break outer;
        same++;
      }
    }
    const from = same === had ? had : Math.floor(same / this.size) * this.size;
    this.redrawn = Math.max(0, Math.min(s.length, had) - from);
    for (let bi = Math.floor(from / this.size); from < had && bi < this.blocks.length; bi++) {
      const b = this.blocks[bi];
      if (!b.drawn.length) continue;
      this.painter.drop(b.pen);
      b.pen.clear();
      b.drawn = [];
    }
    for (let i = from; i < s.length; ) {
      const bi = Math.floor(i / this.size);
      const end = Math.min(s.length, (bi + 1) * this.size);
      const b = this.block(bi);
      b.drawn.push(...s.slice(i, end));
      this.painter.add(drawingOps(d, 0, i, end), b.pen);
      i = end;
    }
  }

  private block(i: number) {
    while (this.blocks.length <= i) this.blocks.push({ pen: new Pen(this.parent.createClip()!), drawn: [] });
    return this.blocks[i];
  }
}

// ---------------------------------------------------------------------------
// obrazovka

/** ukazatel myši (fokus obrazovky vstup bere; ukazatel si držíme sami, Controls počítá držení po resource) */
export function cursor(on: boolean) {
  try {
    if (on) Controls.showCursor();
    else Controls.hideCursor();
  } catch {
    /* bez ukazatele */
  }
}

export function waitReady(screen: NativeScreen, ms = 3000): Promise<boolean> {
  if (screen.ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      resolve(v);
    };
    screen.on("ready", () => finish(true));
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (screen.ready) finish(true);
      else if (!screen.valid || Date.now() - t0 > ms) finish(false);
    }, 50);
  });
}

/** umí obrazovka kreslit a číst myš? (nakreslí čtvereček a změří ho) */
export function probe(root: NativeClip): boolean {
  const c = root.createClip();
  if (!c) return false;
  new Pen(c).rect(0, 0, 10, 10, 0xffffff, 0);
  const w = Number(c.get("_width"));
  const mx = c.get("_xmouse");
  c.remove();
  return w > 5 && typeof mx === "number";
}

export function text(parent: NativeClip, x: number, y: number, w: number, h: number, t: string, size: number, color = 0xf0e6d0, font = "DefaultFont") {
  const f = parent.createText({ x, y, width: w, height: h, text: t });
  f?.setTextStyle({ font, size, color });
  if (f) f.setText(t);
  return f;
}

// ---------------------------------------------------------------------------
// prohlížení kresby

class NativeViewer implements ViewerBackend {
  private screen: NativeScreen | null = null;
  private painter: Painter | null = null;
  onClose: (() => void) | null = null;

  async open(view: ViewMsg, d: Drawing): Promise<boolean> {
    const opened = Date.now();
    let screen: NativeScreen;
    try {
      screen = NativeUI.createScreen();
    } catch {
      return false;
    }
    this.screen = screen;
    if (!(await waitReady(screen)) || !screen.root || !probe(screen.root)) {
      this.close();
      return false;
    }
    const root = screen.root;
    const st = screen.stage() ?? { width: 1920, height: 1080 };
    new Pen(root).rect(0, 0, st.width, st.height, 0x000000, 55);
    const h = st.height * 0.68;
    const w = (h / 2) * 3;
    const x = (st.width - w) / 2;
    const y = st.height * 0.13;
    const sheet = root.createClip()!;
    sheet.set({ x, y, scaleX: w / SRC_W, scaleY: h / SRC_H });
    drawPaper(new Pen(sheet.createClip()!), d.paper);
    const ink = sheet.createClip()!;
    this.painter = new Painter(new Pen(ink), d.paper, 2500);
    this.painter.reset(drawingOps(d));
    const t = text(root, x, y - st.height * 0.08, w, st.height * 0.07, view.title, 34, 0xf0e2c0, "Manuscript");
    t?.setTextStyle({ align: "center" });
    const a = text(root, x, y + h + 8, w, 34, view.author ? "Podepsáno: " + view.author : "Nepodepsáno", 20, 0xd8c8a0, "Manuscript");
    a?.setTextStyle({ align: "right" });
    if (view.loading) {
      const l = text(root, x, y + h + 8, w * 0.6, 30, "◌ Kresba ve světě se ještě načítá, tady je náhled.", 18, 0xe8b25a);
      l?.setTextStyle({ align: "left" });
    }
    btn(root, st.width / 2 - 80, y + h + 48, 160, 44, "Zavřít", () => this.close(), { key: "Esc" });
    screen.on("input", (action: string) => {
      // klávesa, kterou se prohlížení otevřelo (použít v inventáři, Enter), nesmí prohlížení hned zavřít
      if (Date.now() - opened < 600) return;
      if (action === "kcdc_ui_back" || action === "kcdc_ui_accept") this.close();
    });
    screen.focus();
    cursor(true);
    return true;
  }

  close() {
    if (this.screen) cursor(false);
    this.painter?.stop();
    this.painter = null;
    try {
      this.screen?.blur();
      this.screen?.close();
    } catch {
      /* zavřená */
    }
    this.screen = null;
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }
}

export const nativeViewer = new NativeViewer();
