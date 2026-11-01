// Nativní kreslicí plátno (Scaleform): list přesně přes vývěsku (kamera na listu), dole panel ve čtyřech skupinách.
//
//   NÁSTROJ  brk / štětec / uhel / škrabka s ikonou a klávesou 1-4; co hráč nemá, je zašedlé a řekne proč
//   INKOUST  všechny inkousty jedním klikem; které hráč nemá, jsou vidět zamčené a klik řekne, kde je sehnat
//   ŠTĚTEC   živý náhled stopy (stejné vykreslení jako list, ve skutečné velikosti na obrazovce), velikost, krytí
//   KRESBA   název, Zpět / Znovu (Ctrl+Z / Ctrl+Y), Hotovo, Zahodit (Esc 2×) a stav ukládání
//
// Panel zabírá spodních 24 % obrazovky (kamera posouvá list nad něj, client/session.ts).
//
// Vstup: obrazovka drží fokus (myš a akce hry Esc / šipky). Klávesové zkratky jsou navíc přes Key.bind; když je
// hra při fokusu obrazovky nepouští, fungují šipky ← / → (zpět / znovu) a ↑ / ↓ (velikost). Latence kreslení se
// měří (vzorek myši -> čára v clipu) a po zavření plátna zapíše do logu klienta.

import { TOOL, SRC_H, SRC_W, type Drawing, type Stroke } from "../shared/codec";
import { paperOf, PRESSURE, rgbInt, mixRGB } from "../shared/ink";
import { drawingOps, strokeOps, type Ops } from "../shared/vector";
import type { CanvasApi, CanvasBackend } from "./hooks";
import { cursor, drawPaper, Painter, Pen, probe, text, waitReady } from "./native";
import { T } from "./theme";
import { btn, ICONS, lock, slider, type Btn, type Slider } from "./widgets";

const log = (t: string) => console.log("[kresby] " + t);
const TOOL_NAMES = ["Brk", "Štětec", "Uhel", "Škrabka"];
const TOOL_FULL = ["husí brk", "štětce", "uhel", "škrabku"];
const qW = (w: number) => Math.max(0.5, Math.round(w * 4) / 4);
const qA = (a: number) => Math.max(1, Math.min(100, Math.round(a * 25) * 4));

// velikost stopy ve čtvrtpixelech, posuvník logaritmicky mezi limity serveru
let sizeLo = 2;
let sizeHi = 160;
const sizeOf = (v: number) => Math.round(sizeLo * (sizeHi / sizeLo) ** v);
const vOfSize = (s: number) => Math.log(Math.max(sizeLo, Math.min(sizeHi, s)) / sizeLo) / Math.log(sizeHi / sizeLo);

/** měření latence: vzorek myši -> čára v clipu (ms) a odstup vzorků */
export const latency = { n: 0, sum: 0, max: 0, gaps: 0, gapSum: 0, gapMax: 0 };

class NativeCanvas implements CanvasBackend {
  private screen: NativeScreen | null = null;
  private poll: number | null = null;
  private painter: Painter | null = null;
  private rendered = 0;
  private escAt = 0;
  private cleanup: (() => void)[] = [];
  private lastAct = new Map<string, number>();

  async open(api: CanvasApi): Promise<boolean> {
    let screen: NativeScreen;
    try {
      screen = NativeUI.createScreen();
    } catch (e) {
      log("Scaleform obrazovka: " + String(e));
      return false;
    }
    this.screen = screen;
    if (!(await waitReady(screen)) || !screen.root) return this.fail("obrazovka nenaběhla");
    const root = screen.root;
    if (!probe(root)) return this.fail("kreslicí API / _xmouse nefunguje");
    const stage = screen.stage() ?? { width: 1920, height: 1080 };
    await new Promise((r) => setTimeout(r, 120)); // kamera je na listu až další snímek
    this.build(root, stage, this.sheetRect(screen, stage, api), api);
    screen.focus();
    cursor(true);
    return true;
  }

  private fail(why: string): false {
    log("nativní plátno: " + why);
    this.close();
    return false;
  }

  /** akce z myši, klávesy i akce hry; stejná akce dvakrát do 150 ms (Key.bind i fokus) se bere jednou */
  private act(name: string, f: () => void) {
    const now = Date.now();
    if (now - (this.lastAct.get(name) ?? 0) < 150) return;
    this.lastAct.set(name, now);
    f();
  }

  /** obdélník listu na obrazovce (jednotky stage); když promítnutí nevyjde, uprostřed nad panelem */
  private sheetRect(screen: NativeScreen, stage: { width: number; height: number }, api: CanvasApi) {
    const fallback = () => {
      const w = Math.min(stage.width * 0.7, ((stage.height * 0.68) / 2) * 3);
      return { x: (stage.width - w) / 2, y: stage.height * 0.06, w, h: (w / 3) * 2 };
    };
    if (!api.corners) return fallback();
    try {
      const size = Web.getScreenSize();
      const [a, b] = api.corners();
      const pa = Hud.worldToScreen(new Vector3(a[0], a[1], a[2]));
      const pb = Hud.worldToScreen(new Vector3(b[0], b[1], b[2]));
      if (!pa || !pb || !pa.onScreen || !pb.onScreen) return fallback();
      const sa = screen.screenToStage(pa.x / size.width, pa.y / size.height);
      const sb = screen.screenToStage(pb.x / size.width, pb.y / size.height);
      if (!sa || !sb) return fallback();
      const w = sb.x - sa.x;
      const h = sb.y - sa.y;
      if (w < stage.width * 0.25 || h <= 0 || Math.abs(w / h - 1.5) > 0.25 || sb.y > stage.height * 0.77) return fallback();
      return { x: sa.x, y: sa.y, w, h };
    } catch {
      return fallback();
    }
  }

  private build(root: NativeClip, stage: { width: number; height: number }, rect: { x: number; y: number; w: number; h: number }, api: CanvasApi) {
    const W = stage.width;
    const H = stage.height;
    const scale = rect.w / SRC_W; // logický px listu -> stage
    // list: podklad, hotové tahy, rozkreslený tah
    const sheet = root.createClip()!;
    sheet.set({ x: rect.x, y: rect.y, scaleX: scale, scaleY: rect.h / SRC_H });
    const paperClip = sheet.createClip()!;
    drawPaper(new Pen(paperClip), api.msg.paper);
    const ink = sheet.createClip()!;
    const cur = sheet.createClip()!;
    const curPen = new Pen(cur);
    this.painter = new Painter(new Pen(ink), api.msg.paper);
    this.painter.reset(drawingOps(api.drawing()));
    this.rendered = api.strokes.length;

    // panel: kreslí se v jednotkách 1920 × 216, přizpůsobí se stage
    const k = Math.min(W / 1920, H / 1080);
    const panelY = H * 0.76;
    const panel = root.createClip()!;
    panel.set({ x: 0, y: panelY, scaleX: k, scaleY: k });
    const PW = W / k;
    const pp = new Pen(panel);
    pp.rect(0, 0, PW, (H - panelY) / k, T.panel, T.panelA);
    pp.line(2, T.edge, 100);
    pp.move(0, 1);
    pp.to(PW, 1);
    const caption = (x: number, t: string) => text(panel, x, 8, 300, 20, t, 14, T.gold, T.font);

    // hlášení nad panelem (došel inkoust, kde sehnat zamčený inkoust …)
    const note = root.createClip()!;
    note.set({ x: 24 * k, y: panelY - 46 * k, scaleX: k, scaleY: k, visible: false });
    const noteBg = new Pen(note);
    const noteText = text(note, 12, 7, 1200, 26, "", T.body, T.text, T.font);
    let noteTimer: number | null = null;
    const say = (t: string, tone: number = T.text, ms = 6000) => {
      if (noteTimer !== null) clearTimeout(noteTimer);
      noteTimer = null;
      if (!t) return void note.set({ visible: false });
      noteBg.clear();
      noteBg.rect(0, 0, Math.min(1400, 40 + t.length * 9.5), 38, T.surface, 100);
      noteBg.frame(0, 0, Math.min(1400, 40 + t.length * 9.5), 38, 1.5, tone, 100);
      noteText?.setText(t);
      noteText?.setTextStyle({ color: tone });
      note.set({ visible: true });
      noteTimer = setTimeout(() => note.set({ visible: false }), ms);
    };
    this.cleanup.push(() => noteTimer !== null && clearTimeout(noteTimer));

    // NÁSTROJ
    caption(24, "NÁSTROJ");
    const tools: { t: number; b: Btn }[] = [];
    [TOOL.pen, TOOL.brush, TOOL.charcoal, TOOL.scrape].forEach((t, i) => {
      const have = api.msg.tools.includes(t);
      const b = btn(panel, 24 + i * 86, 34, 78, 82, TOOL_NAMES[t], () => this.act("tool", () => pickTool(t)), { key: String(i + 1), icon: ICONS[t], size: 16 });
      if (!have) b.set("dis");
      tools.push({ t, b });
    });
    const pickTool = (t: number) => {
      if (!api.msg.tools.includes(t)) return say(`Nemáš ${TOOL_FULL[t]}. Koupíš ho u písaře.`, T.warn);
      api.brush.tool = t;
      if ((t === TOOL.pen || t === TOOL.brush) && !api.brush.a && api.msg.inks.length) api.brush.a = 1;
      refresh();
    };

    // INKOUST: vlastní (s kapkami) + zamčené (s radou, kde je sehnat), nejvýš 16
    caption(392, "INKOUST");
    let mixing = false;
    const own = api.msg.inks.map((x, i) => ({ ...x, i, where: "" })).filter((x) => x.pick !== false); // předloha (volná relace) se nevybírá
    const locked = (api.msg.locked ?? []).map((x) => ({ ...x, i: -1, drops: 0, strength: 0 }));
    const all = [...own, ...locked].slice(0, 16);
    const SW = 44;
    const swatches = all.map((inkInfo, n) => {
      const x = 392 + (n % 8) * (SW + 8);
      const y = 34 + Math.floor(n / 8) * (SW + 18);
      const c = panel.createClip()!;
      c.set({ x, y });
      const pen = new Pen(c);
      const label = text(panel, x - 6, y + SW, SW + 12, 18, "", 13, T.dim, T.font);
      label?.setTextStyle({ align: "center" });
      const draw = (sel: number, drops: number) => {
        pen.clear();
        if (inkInfo.i < 0) {
          // zamčený: vybledlá barva, šrafování, zámeček
          pen.rect(0, 0, SW, SW, rgbInt(inkInfo.rgb), 30);
          pen.line(1, T.dim, 45);
          for (let d = -SW; d < SW; d += 9) {
            pen.move(Math.max(0, d), Math.max(0, -d));
            pen.to(Math.min(SW, d + SW), Math.min(SW, SW - d));
          }
          lock(pen, SW / 2, SW / 2 + 3, 14);
          pen.frame(0, 0, SW, SW, 1, T.edge, 70);
          label?.setText("");
          return;
        }
        pen.rect(0, 0, SW, SW, rgbInt(inkInfo.rgb), drops > 0 ? 100 : 40);
        if (inkInfo.flags & 2) pen.rect(SW * 0.15, SW * 0.15, SW * 0.3, SW * 0.12, 0xfff4c8, 70);
        pen.frame(0, 0, SW, SW, sel ? 3.5 : 1, sel === 1 ? T.gold : sel === 2 ? T.second : T.edge, 100);
        label?.setText(api.msg.unlimited ? "" : drops > 0 ? String(Math.floor(drops)) : "došel");
      };
      c.on("press", () => this.act("ink", () => pickInk(n)));
      return { info: inkInfo, draw };
    });
    const pickInk = (n: number) => {
      const sv = swatches[n];
      if (!sv) return;
      if (sv.info.i < 0) return say(`${sv.info.name}: nemáš. ${sv.info.where}`, T.warn, 9000);
      const i = sv.info.i;
      if (mixing && api.brush.a && api.brush.a !== i + 1) api.brush.b = api.brush.b === i + 1 ? 0 : i + 1;
      else {
        api.brush.a = i + 1;
        if (api.brush.b === i + 1) api.brush.b = 0;
        if (api.brush.tool === TOOL.charcoal || api.brush.tool === TOOL.scrape) api.brush.tool = api.msg.tools.includes(TOOL.pen) ? TOOL.pen : TOOL.brush;
      }
      say(sv.info.name + (api.brush.b ? " + " + api.msg.inks[api.brush.b - 1].name : ""), T.text, 2500);
      refresh();
    };
    const cycleInk = (d: number) => {
      if (!own.length) return;
      const cur0 = Math.max(0, api.brush.a - 1);
      pickInk((cur0 + d + own.length) % own.length);
    };
    const mixY = 32 + 2 * (SW + 18) + 6;
    const mixBtn = own.length >= 2
      ? btn(panel, 392, mixY, 150, 34, "Přimíchat", () => this.act("mix", () => {
          mixing = !mixing;
          if (!mixing) api.brush.b = 0;
          say(mixing ? "Klikni na druhý inkoust, který se přimíchá." : "", T.text, 4000);
          refresh();
        }), { size: 16 })
      : null;
    const ratio = slider(panel, 560, mixY + 8, 230, "Poměr", api.brush.mix / 255, (v) => `${Math.round((1 - v) * 100)} : ${Math.round(v * 100)}`, (v) => ((api.brush.mix = Math.round(v * 255)), preview()));

    // ŠTĚTEC: náhled stopy + velikost a krytí
    caption(832, "ŠTĚTEC");
    const prev = panel.createClip()!;
    prev.set({ x: 832, y: 34 });
    const prevPen = new Pen(prev);
    prevPen.rect(0, 0, 270, 82, rgbInt(paperOf(api.msg.paper).rgb), 100);
    prevPen.frame(0, 0, 270, 82, 1.5, T.edge, 100);
    // náhled kreslí ve stejném měřítku jako list (k = stage -> panel), takže velikost odpovídá tomu, co hráč uvidí
    const ps = scale / k;
    const prevInk = prev.createClip()!;
    prevInk.set({ scaleX: ps, scaleY: ps });
    const prevSize = text(panel, 832, 118, 270, 18, "", 13, T.dim, T.font);
    const preview = () => {
      const b = api.brush;
      const lw = 270 / ps;
      const lh = 82 / ps;
      const pts: number[] = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        pts.push(Math.round(lw * (0.1 + 0.8 * t)), Math.round(lh * (0.5 - 0.28 * Math.sin(t * Math.PI * 2))), Math.round(15 - 6 * Math.abs(t - 0.5)));
      }
      const s: Stroke = { tool: b.tool, a: b.a, b: b.b, mix: b.mix, size: b.size, op: b.op, p: pts };
      const d: Drawing = { paper: api.msg.paper, inks: api.drawing().inks, strokes: [s] };
      const pen = new Pen(prevInk);
      pen.clear();
      const pt = new Painter(pen, api.msg.paper, 100000);
      pt.add(drawingOps(d));
      pt.stop();
      prevSize?.setText(`${TOOL_NAMES[b.tool]}, ${(b.size / 4).toFixed(1)} px, krytí ${Math.round(b.op / 2.55)} %`);
    };
    sizeLo = Math.max(2, api.msg.limits.sizeMin ?? 2);
    sizeHi = Math.max(sizeLo + 1, Math.min(160, api.msg.limits.sizeMax ?? 160));
    api.brush.size = Math.max(sizeLo, Math.min(sizeHi, api.brush.size));
    const size = slider(panel, 832, 176, 125, "Velikost", vOfSize(api.brush.size), (v) => (sizeOf(v) / 4).toFixed(1) + " px", (v) => ((api.brush.size = sizeOf(v)), preview()));
    const op = slider(panel, 977, 176, 125, "Krytí", (api.brush.op - 13) / 242, (v) => Math.round((13 + v * 242) / 2.55) + " %", (v) => ((api.brush.op = Math.round(13 + v * 242)), preview()));
    const nudgeSize = (d: number) => {
      api.brush.size = sizeOf(Math.max(0, Math.min(1, vOfSize(api.brush.size) + d)));
      size.set(vOfSize(api.brush.size));
      preview();
    };

    // KRESBA: název, akce, stav ukládání
    caption(1126, "KRESBA");
    text(panel, 1126, 30, 380, 18, "Název", 13, T.dim, T.font);
    const title = panel.createText({ x: 1126, y: 50, width: 380, height: 36, text: api.msg.title === "Kresba" ? "" : api.msg.title });
    if (title) {
      title.setTextStyle({ font: T.title, size: 22, color: T.paperText });
      title.setMember("type", "input");
      title.setMember("maxChars", 48);
      title.setMember("background", true);
      title.setMember("backgroundColor", T.paper);
      title.setMember("border", true);
    }
    const saved = text(panel, 1526, 54, 380, 26, "", T.body, T.ok, T.font);
    const undoB = btn(panel, 1126, 100, 120, 54, "Zpět", () => this.act("undo", () => undo()), { key: "Ctrl+Z" });
    const redoB = btn(panel, 1256, 100, 120, 54, "Znovu", () => this.act("redo", () => redo()), { key: "Ctrl+Y" });
    const doneB = btn(panel, 1386, 100, 200, 54, "Hotovo", () => this.act("done", () => finish()), { strong: true });
    const dropB = btn(panel, 1596, 100, 160, 54, "Zahodit", () => this.act("drop", () => discard()), { key: "Esc 2×" });
    let finishing = false;
    const undo = () => (api.undo(), refresh());
    const redo = () => {
      const why = api.redo?.();
      if (why) say(why, T.warn);
      redrawAll();
    };
    const finish = () => {
      if (finishing) return;
      finishing = true;
      cancelStroke();
      refresh();
      api.finish(String(title?.getText() ?? "").trim() || api.msg.title);
    };
    const discard = () => {
      if (Date.now() - this.escAt < 3000) return api.cancel();
      this.escAt = Date.now();
      say(api.strokes.length ? "Ještě jednou Esc nebo Zahodit: kresba se zahodí, list i inkoust zůstanou." : "Ještě jednou Esc nebo Zahodit: plátno se zavře.", T.warn, 3000);
    };

    // nápověda kláves
    const help = text(panel, 24, 226, PW - 48, 22, "Levým tlačítkem kreslíš   ·   1–4 nástroj   ·   Q / E inkoust   ·   kolečko nebo ↑ / ↓ velikost   ·   Ctrl+Z nebo ← zpět   ·   Ctrl+Y nebo → znovu   ·   Esc 2× zahodit", T.small, T.dim, T.font);
    help?.setTextStyle({ align: "center" });

    const refresh = () => {
      for (const { t, b } of tools) if (api.msg.tools.includes(t)) b.set(api.brush.tool === t ? "on" : "off");
      const drops = api.drops();
      const inked = api.brush.tool === TOOL.pen || api.brush.tool === TOOL.brush;
      swatches.forEach((sv) => sv.draw(sv.info.i < 0 ? 0 : !inked ? 0 : api.brush.a === sv.info.i + 1 ? 1 : api.brush.b === sv.info.i + 1 ? 2 : 0, drops[sv.info.i] ?? 0));
      mixBtn?.set(mixing ? "on" : "off");
      ratio.visible(mixing && !!api.brush.b);
      undoB.set(api.strokes.length && !finishing ? "off" : "dis");
      redoB.set(api.canRedo?.() && !finishing ? "off" : "dis");
      doneB.set(finishing ? "dis" : "off");
      doneB.label(finishing ? "Ukládám…" : "Hotovo");
      const st = api.saveState?.() ?? { pending: 0, finishing: false };
      const err = api.status();
      if (finishing || st.finishing) (saved?.setText("◌ Ukládám hotovou kresbu…"), saved?.setTextStyle({ color: T.warn }));
      else if (st.pending) (saved?.setText(`◌ Ukládám ${st.pending} ${st.pending === 1 ? "tah" : st.pending < 5 ? "tahy" : "tahů"}…`), saved?.setTextStyle({ color: T.warn }));
      else if (api.strokes.length) (saved?.setText("✓ Vše uloženo"), saved?.setTextStyle({ color: T.ok }));
      else (saved?.setText("Prázdný list"), saved?.setTextStyle({ color: T.dim }));
      if (err && err !== lastErr) say(err, T.bad);
      lastErr = err;
      preview();
    };
    let lastErr = "";
    const redrawAll = () => {
      this.painter?.reset(drawingOps(api.drawing()));
      this.rendered = api.strokes.length;
      refresh();
    };
    api.onChange((why) => (why === "reject" || why === "undo" || why === "reset" ? redrawAll() : refresh()));

    // kreslení: stisk na listu -> vzorky myši po 8 ms (v praxi každý snímek) do puštění
    let pts: number[] = [];
    let lastT = 0;
    let pr = 1;
    const brushColor = (): number => {
      const b = api.brush;
      if (b.tool === TOOL.charcoal) return 0x221f1e;
      if (b.tool === TOOL.scrape) return rgbInt(paperOf(api.msg.paper).rgb);
      const A = api.msg.inks[b.a - 1];
      const B = b.b ? api.msg.inks[b.b - 1] : null;
      return A ? rgbInt(B ? mixRGB(A.rgb, B.rgb, b.mix / 255) : A.rgb) : 0x221f1e;
    };
    const sample = () => {
      const t0 = Date.now();
      const mx = Number(sheet.get("_xmouse"));
      const my = Number(sheet.get("_ymouse"));
      if (!Number.isFinite(mx) || !Number.isFinite(my)) return;
      const x = Math.max(0, Math.min(767, mx));
      const y = Math.max(0, Math.min(511, my));
      const n = pts.length;
      if (n) {
        const d = Math.hypot(x - pts[n - 3], y - pts[n - 2]);
        if (d < 1.2) return;
        const speed = d / Math.max(1, t0 - lastT);
        pr = pr * 0.75 + Math.max(0.2, Math.min(1, 1.15 - speed * 0.55)) * 0.25;
        const w = Math.max(0.5, (api.brush.size / 4) * (PRESSURE[api.brush.tool] ?? PRESSURE[0])(pr));
        curPen.line(qW(w), brushColor(), qA(api.brush.op / 255));
        curPen.to(x, y);
        const gap = t0 - lastT;
        latency.gaps++;
        latency.gapSum += gap;
        latency.gapMax = Math.max(latency.gapMax, gap);
      } else {
        curPen.clear();
        curPen.line(qW(api.brush.size / 4), brushColor(), qA(api.brush.op / 255));
        curPen.move(x, y);
        curPen.to(x + 0.3, y);
      }
      const dt = Date.now() - t0;
      latency.n++;
      latency.sum += dt;
      latency.max = Math.max(latency.max, dt);
      lastT = t0;
      pts.push(x, y, Math.round(pr * 15));
    };
    const cancelStroke = () => {
      if (this.poll !== null) clearInterval(this.poll);
      this.poll = null;
      pts = [];
      curPen.clear();
    };
    const end = () => {
      if (this.poll === null) return;
      clearInterval(this.poll);
      this.poll = null;
      sample();
      const p = pts;
      pts = [];
      curPen.clear();
      const why = api.addStroke(p);
      if (why) say(why, T.bad);
      else {
        const d = api.drawing();
        const ops: Ops = { runs: [], dots: [], segments: 0 };
        for (let i = this.rendered; i < d.strokes.length; i++) strokeOps(d.strokes[i], d, i + 1, 0, ops);
        this.rendered = d.strokes.length;
        this.painter?.add(ops);
      }
      refresh();
    };
    paperClip.on("press", () => {
      if (this.poll !== null || finishing) return;
      pts = [];
      pr = 1;
      lastT = Date.now();
      sample();
      this.poll = setInterval(sample, 8);
    });
    paperClip.on("release", end);
    paperClip.on("releaseOutside", end);

    // klávesy: akce hry při fokusu + Key.bind (zkratky, když je hra pustí)
    this.screen?.on("input", (action: string) => {
      if (action === "kcdc_ui_back") this.act("esc", discard);
      else if (action === "kcdc_ui_left") this.act("undo", undo);
      else if (action === "kcdc_ui_right") this.act("redo", redo);
      else if (action === "kcdc_ui_up") this.act("size", () => nudgeSize(0.08));
      else if (action === "kcdc_ui_down") this.act("size", () => nudgeSize(-0.08));
    });
    const ctrl = () => {
      try {
        return Key.isDown("lctrl") || Key.isDown("rctrl");
      } catch {
        return false;
      }
    };
    const keys: [string, () => void][] = [
      ["1", () => this.act("tool", () => pickTool(TOOL.pen))],
      ["2", () => this.act("tool", () => pickTool(TOOL.brush))],
      ["3", () => this.act("tool", () => pickTool(TOOL.charcoal))],
      ["4", () => this.act("tool", () => pickTool(TOOL.scrape))],
      ["q", () => this.act("ink", () => cycleInk(-1))],
      ["e", () => this.act("ink", () => cycleInk(1))],
      ["wheelup", () => nudgeSize(0.05)],
      ["wheeldown", () => nudgeSize(-0.05)],
      ["z", () => ctrl() && this.act("undo", undo)],
      ["y", () => ctrl() && this.act("redo", redo)],
      ["escape", () => this.act("esc", discard)],
    ];
    for (const [key, f] of keys) {
      try {
        Key.bind(key, "down", f);
        this.cleanup.push(() => Key.unbind(key, "down", f));
      } catch {
        /* klávesa, kterou hra nezná */
      }
    }
    this.cleanup.push(() => (size.stop(), op.stop(), ratio.stop()));
    refresh();
  }

  hide() {
    this.screen?.blur();
    this.screen?.setVisible(false);
  }

  close() {
    if (this.screen) cursor(false);
    if (this.poll !== null) clearInterval(this.poll);
    this.poll = null;
    for (const f of this.cleanup.splice(0)) {
      try {
        f();
      } catch {
        /* už pryč */
      }
    }
    this.painter?.stop();
    this.painter = null;
    try {
      this.screen?.blur();
      this.screen?.close();
    } catch {
      /* už je zavřená */
    }
    if (this.screen && latency.n) {
      log(`plátno: ${latency.n} vzorků myši, vzorek -> čára prům. ${(latency.sum / latency.n).toFixed(2)} ms (max ${latency.max} ms), odstup vzorků prům. ${(latency.gapSum / Math.max(1, latency.gaps)).toFixed(1)} ms (max ${latency.gapMax} ms)`);
    }
    this.screen = null;
  }
}

export const nativeCanvas = new NativeCanvas();
