// Relace kreslení v klientu: tahy, dávky na server, potvrzení, odhad spotřeby, zpět, kamera na list.
// Backend UI (native.ts / web.ts / vlastní) dostane tenhle objekt jako CanvasApi.

import { emitServer } from "./net";
import { TOOL, encodeK3, decode, type Drawing, type Ink, type Stroke } from "../shared/codec";
import { strokeUse } from "../shared/ink";
import { axes, sheetPoint, viewPoint, type Face, type Slot, type V3 } from "../shared/layout";
import { EV, type AckMsg, type CanvasMsg } from "../shared/protocol";
import type { Brush, CanvasApi } from "./hooks";

const MAX_STROKE_POINTS = 300; // delší tah se rozdělí (menší zprávy, rychlejší potvrzení)

interface Item {
  s: Stroke;
  use: { a: number; b: number; c: number };
  seq: number; // 0 = ještě neodeslaný
}

export class CanvasSession implements CanvasApi {
  readonly strokes: Stroke[] = [];
  brush: Brush;
  private items: Item[] = [];
  private seq: number;
  private ackDrops: number[];
  private ackCharcoal: number;
  private inflight = new Map<number, Item[]>();
  private undoWanted = 0;
  private undone = new Set<Item>(); // vzaté zpět, ale server je ještě nepotvrdil
  private timer: number | null = null;
  private listeners: ((why: "ack" | "reject" | "undo" | "reset") => void)[] = [];
  private finishing: string | null = null;
  private msgStatus = "";
  private redoStack: Stroke[] = []; // vzaté zpět (Ctrl+Y je vrátí)
  readonly inks: Ink[];
  readonly face: Face;
  readonly slot: Slot;

  constructor(readonly msg: CanvasMsg) {
    this.seq = msg.seq ?? 0;
    this.ackDrops = msg.inks.map((i) => i.drops);
    this.ackCharcoal = msg.charcoal;
    this.inks = msg.inks.map((i) => ({ rgb: i.rgb, flags: i.flags, strength: i.strength }));
    const first = msg.tools.find((t) => t !== TOOL.scrape) ?? TOOL.scrape;
    this.brush = { tool: first, a: msg.inks.length && first !== TOOL.charcoal ? 1 : 0, b: 0, mix: 128, size: first === TOOL.brush ? 24 : 8, op: 255 };
    const sh = msg.sheet;
    this.face = { pos: sh.pos, n: sh.n, w: sh.w, h: sh.h, cols: 1, rows: 1 };
    this.slot = { cx: sh.cx, cy: sh.cy, w: sh.sw, h: sh.sh };
    if (msg.resume) {
      const d = decode(msg.resume, msg.inks.length);
      for (const s of d?.strokes ?? []) {
        const it = { s, use: this.useOf(s), seq: this.seq };
        this.items.push(it);
        this.strokes.push(s);
      }
    }
  }

  private useOf(s: Stroke) {
    const u = strokeUse(s, this.inks, this.msg.limits.dropArea);
    return { a: u.a, b: u.b, c: u.charcoal };
  }

  onChange(cb: (why: "ack" | "reject" | "undo" | "reset") => void) {
    this.listeners.push(cb);
  }
  private emit(why: "ack" | "reject" | "undo" | "reset") {
    for (const l of this.listeners) {
      try {
        l(why);
      } catch (e) {
        console.log("[kresby] plátno: " + String(e));
      }
    }
  }

  status() {
    return this.msgStatus;
  }

  /** kapky: poslední potvrzené minus to, co ještě server nepotvrdil */
  drops(): number[] {
    const d = [...this.ackDrops];
    for (const it of this.items) {
      if (it.seq && it.seq <= this.seq && !this.inflight.has(it.seq)) continue;
      if (it.s.a) d[it.s.a - 1] -= it.use.a;
      if (it.s.b) d[it.s.b - 1] -= it.use.b;
    }
    return d.map((v) => Math.max(0, v));
  }

  charcoal(): number {
    let c = this.ackCharcoal;
    for (const it of this.items) if (!it.seq || this.inflight.has(it.seq)) c -= it.use.c;
    return Math.max(0, c);
  }

  private points() {
    let n = 0;
    for (const it of this.items) n += it.s.p.length / 3;
    return n;
  }

  drawing(): Drawing {
    return { paper: this.msg.paper, inks: this.inks, strokes: this.strokes };
  }

  addStroke(p: number[], brush: Brush = this.brush): string | null {
    const r = this.add(p, brush);
    if (r === null) this.redoStack = [];
    return r;
  }

  private add(p: number[], brush: Brush): string | null {
    if (this.finishing !== null) return "Kresba se ukládá.";
    const b = { ...brush };
    if (!this.msg.tools.includes(b.tool)) return "Ten nástroj nemáš.";
    const inked = b.tool === TOOL.pen || b.tool === TOOL.brush;
    if (inked && !b.a) return "Vyber inkoust.";
    if (!inked) (b.a = 0), (b.b = 0);
    if (b.b === b.a) b.b = 0;
    b.size = Math.max(2, Math.min(160, Math.round(b.size)));
    b.op = Math.max(13, Math.min(255, Math.round(b.op)));
    b.mix = b.b ? Math.max(0, Math.min(255, Math.round(b.mix))) : 0;
    const pts: number[] = [];
    for (let i = 0; i + 2 < p.length; i += 3) {
      pts.push(Math.max(0, Math.min(767, Math.round(p[i]))), Math.max(0, Math.min(511, Math.round(p[i + 1]))), Math.max(0, Math.min(15, Math.round(p[i + 2]))));
    }
    if (!pts.length) return null;
    const lim = this.msg.limits;
    if (this.strokes.length >= lim.strokes || this.points() + pts.length / 3 > lim.points) return (this.msgStatus = "List je plný."), "List je plný.";
    // dlouhý tah po kusech (překryv 1 bod, ať se nerozpadne)
    const parts: number[][] = [];
    for (let i = 0; i < pts.length / 3; i += MAX_STROKE_POINTS - 1) parts.push(pts.slice(i * 3, (i + MAX_STROKE_POINTS) * 3));
    const drops = this.drops();
    let charcoal = this.charcoal();
    const add: Item[] = [];
    for (const part of parts) {
      if (part.length < 3) continue;
      const s: Stroke = { tool: b.tool, a: b.a, b: b.b, mix: b.mix, size: b.size, op: b.op, p: part };
      const use = this.useOf(s);
      if (inked && (drops[b.a - 1] - use.a < -0.999 || (b.b && drops[b.b - 1] - use.b < -0.999))) {
        this.msgStatus = "Došel inkoust: " + this.msg.inks[(drops[b.a - 1] - use.a < -0.999 ? b.a : b.b) - 1].name + ".";
        if (!add.length) return this.msgStatus;
        break;
      }
      if (b.tool === TOOL.charcoal && charcoal - use.c < -this.msg.limits.charcoalArea * 0.02) {
        this.msgStatus = "Došel uhel.";
        if (!add.length) return this.msgStatus;
        break;
      }
      if (b.a) drops[b.a - 1] -= use.a;
      if (b.b) drops[b.b - 1] -= use.b;
      charcoal -= use.c;
      add.push({ s, use, seq: 0 });
    }
    for (const it of add) {
      this.items.push(it);
      this.strokes.push(it.s);
    }
    this.schedule();
    return null;
  }

  private schedule() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.send();
    }, 120);
  }

  /** pošle neodeslané tahy dávkami */
  send() {
    const lim = this.msg.limits;
    for (;;) {
      const batch: Item[] = [];
      let pts = 0;
      for (const it of this.items) {
        if (it.seq) continue;
        if (batch.length >= lim.batch || pts + it.s.p.length / 3 > lim.batchPoints) break;
        batch.push(it);
        pts += it.s.p.length / 3;
      }
      if (!batch.length) break;
      const seq = ++this.seq;
      for (const it of batch) it.seq = seq;
      this.inflight.set(seq, batch);
      emitServer(EV.tahy, { s: this.msg.s, seq, d: encodeK3({ paper: this.msg.paper, inks: [], strokes: batch.map((i) => i.s) }) });
    }
  }

  onAck(m: AckMsg) {
    const batch = this.inflight.get(m.seq);
    this.inflight.delete(m.seq);
    this.ackDrops = m.drops;
    this.ackCharcoal = m.charcoal;
    let rejected = false;
    const done = () => batch && batch.forEach((it) => this.undone.delete(it));
    if (batch && m.rej.length) {
      for (const i of m.rej) {
        const it = batch[i];
        const k = it ? this.items.indexOf(it) : -1;
        if (k >= 0) {
          this.items.splice(k, 1);
          this.strokes.splice(this.strokes.indexOf(it.s), 1);
          rejected = true;
        } else if (it && this.undone.has(it)) this.undoWanted--; // server ho nemá, není co brát zpět
      }
      this.msgStatus = m.why ?? "Server některé tahy odmítl (došel inkoust nebo je list plný).";
    }
    done();
    this.emit(rejected ? "reject" : "ack");
    this.flushUndo();
    if (this.finishing !== null && !this.inflight.size && !this.undoWanted) this.doFinish();
  }

  canRedo() {
    return this.redoStack.length > 0 && this.finishing === null;
  }

  /** vrátí poslední tah vzatý zpět (projde stejnými pravidly jako nový: inkoust, limity) */
  redo(): string | null {
    const s = this.redoStack.pop();
    if (!s || this.finishing !== null) return null;
    const why = this.add(s.p, { tool: s.tool, a: s.a, b: s.b, mix: s.mix, size: s.size, op: s.op });
    if (why) this.redoStack.push(s);
    else this.emit("undo");
    return why;
  }

  /** stav ukládání pro hráče: kolik tahů server ještě nepotvrdil, jestli se dokončuje */
  saveState(): { pending: number; finishing: boolean } {
    let pending = 0;
    for (const it of this.items) if (!it.seq || this.inflight.has(it.seq)) pending++;
    return { pending: pending + this.undoWanted, finishing: this.finishing !== null };
  }

  undo() {
    if (this.finishing !== null || !this.items.length) return;
    const last = this.items[this.items.length - 1];
    this.redoStack.push(last.s);
    if (!last.seq) {
      // ještě neodeslaný: stačí zahodit
      this.items.pop();
      this.strokes.pop();
      this.emit("undo");
      return;
    }
    this.undoWanted++;
    if (this.inflight.has(last.seq)) this.undone.add(last);
    this.items.pop();
    this.strokes.pop();
    this.emit("undo");
    this.flushUndo();
  }

  /** zpět na serveru až nic nečeká na potvrzení (jinak by odmítnutý tah posunul pořadí) */
  private flushUndo() {
    if (!this.undoWanted || this.inflight.size) return;
    emitServer(EV.zpet, { s: this.msg.s, n: this.undoWanted });
    this.undoWanted = 0;
  }

  finish(title: string) {
    if (this.finishing !== null) return;
    this.finishing = title;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.send();
    if (!this.inflight.size && !this.undoWanted) this.doFinish();
  }

  private doFinish() {
    const t = this.finishing ?? "";
    emitServer(EV.hotovo, { s: this.msg.s, title: t });
  }

  cancel() {
    emitServer(EV.konec, { s: this.msg.s });
  }

  stop() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------------------
  // kamera na list

  /** záběr kamery na list; vrátí false, když hra kameru nedá */
  shot(): boolean {
    const pose = Camera.getPose();
    if (!pose) return false;
    // list na 66 % výšky a o 10 % výš než střed obrazovky: dole je panel nástrojů (platno.ts, 76-100 %)
    const fov = pose.fov || 55;
    const ax = axes(this.face.n);
    const eye = viewPoint(this.face, this.slot, fov, pose.aspectRatio || 16 / 9, 0.66);
    const c = sheetPoint(this.face, this.slot, ax, 384, 256, 0);
    const d = Math.hypot(eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]);
    const shift = 0.2 * d * Math.tan((fov / 2) * (Math.PI / 180));
    const down = (p: V3) => new Vector3(p[0] - ax.v[0] * shift, p[1] - ax.v[1] * shift, p[2] - ax.v[2] * shift);
    try {
      // střih (duration 0): plátno se hned potom napasuje na promítnuté rohy listu
      return Camera.setShot({ position: down(eye), lookAt: down(c), duration: 0 });
    } catch {
      return false;
    }
  }

  clearShot() {
    try {
      Camera.clearShot(400);
    } catch {
      /* není co vrátit */
    }
  }

  /** rohy listu ve světě (levý horní, pravý dolní) - pro obdélník plátna na obrazovce */
  corners(): [V3, V3] {
    const ax = axes(this.face.n);
    return [sheetPoint(this.face, this.slot, ax, 0, 0, 0), sheetPoint(this.face, this.slot, ax, 768, 512, 0)];
  }
}
