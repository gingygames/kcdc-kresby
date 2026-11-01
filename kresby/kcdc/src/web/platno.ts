// Skript záložního HTML plátna (ui/platno.html). Kreslí stejné čáry jako nativní cesta (src/shared/vector.ts),
// průhledné inkousty násobí s podkladem (globalCompositeOperation "multiply") a papír má rastrový šum jako
// serverové vykreslení KCD:MP. Tahy posílá klientskému skriptu (client/web.ts), pravidla drží CanvasApi tam.

import { SRC_H, SRC_W, TOOL, decode, type Drawing } from "../shared/codec";
import { paperOf, PRESSURE, mixRGB, rgbInt } from "../shared/ink";
import { drawingOps, hash, strokeOps, type Ops } from "../shared/vector";

declare const callEvent: ((name: string, json: string | null) => void) | undefined;
const send = (name: string, payload?: unknown) => {
  if (typeof callEvent === "function") callEvent(name, payload === undefined ? null : JSON.stringify(payload));
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const wrap = $("wrap");
const canvas = $<HTMLCanvasElement>("sheet");
const ctx = canvas.getContext("2d")!;
const TOOL_NAMES = ["Brk", "Štětec", "Uhel", "Škrabka"];

interface Msg {
  msg: { s: number; paper: number; tools: number[]; inks: { name: string; rgb: [number, number, number]; flags: number; strength: number; drops: number; pick?: false }[]; title: string; unlimited?: true };
  d: string;
  brush: { tool: number; a: number; b: number; mix: number; size: number; op: number };
  drops: number[];
  charcoal: number;
  status: string;
}

let cur: Msg | null = null;
let drawing: Drawing = { paper: 0, inks: [], strokes: [] };
let paperImg: ImageData | null = null;
let mixing = false;
let view = false;

function hex(c: number) {
  return "#" + c.toString(16).padStart(6, "0");
}

// papír: šum jako kresby_png.lua (pergamen skvrny, papír žebrování, ztmavlé okraje)
function noise(x: number, y: number, s: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, s);
  const b = hash(ix + 1, iy, s);
  const c = hash(ix, iy + 1, s);
  const d = hash(ix + 1, iy + 1, s);
  return a + (b - a) * fx + (c + (d - c) * fx - (a + (b - a) * fx)) * fy;
}

function paper(kind: number): ImageData {
  const img = ctx.createImageData(SRC_W, SRC_H);
  const base = paperOf(kind).rgb;
  for (let y = 0; y < SRC_H; y++) {
    for (let x = 0; x < SRC_W; x++) {
      let sh =
        kind === 1
          ? (noise(x / 6, y / 6, 11) - 0.5) * 4 + (x % 110 < 2 ? -7 : 0)
          : (noise(x / 40, y / 40, 7) - 0.5) * 16 + (noise(x / 9, y / 9, 8) - 0.5) * 5;
      const e = Math.min(1, Math.min(x, SRC_W - 1 - x) / (SRC_W * 0.12), Math.min(y, SRC_H - 1 - y) / (SRC_H * 0.12));
      sh -= (1 - e) * (1 - e) * 22;
      const i = (y * SRC_W + x) * 4;
      img.data[i] = base[0] + sh;
      img.data[i + 1] = base[1] + sh;
      img.data[i + 2] = base[2] + sh * 1.25;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

function paint(ops: Ops) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const r of ops.runs) {
    ctx.globalCompositeOperation = r.mode === 0 ? "multiply" : "source-over";
    const color = r.mode === 2 ? hex(rgbInt(paperOf(drawing.paper).rgb)) : hex(r.color);
    ctx.strokeStyle = color;
    for (let i = 0; i < r.w.length; i++) {
      ctx.globalAlpha = Math.min(1, r.a[i]);
      ctx.lineWidth = Math.max(0.5, r.w[i]);
      ctx.beginPath();
      ctx.moveTo(r.pts[i * 2], r.pts[i * 2 + 1]);
      ctx.lineTo(r.pts[i * 2 + 2], r.pts[i * 2 + 3]);
      ctx.stroke();
    }
  }
  for (const d of ops.dots) {
    ctx.globalCompositeOperation = d.mode === 0 ? "multiply" : "source-over";
    ctx.globalAlpha = d.alpha;
    ctx.fillStyle = hex(d.color);
    ctx.beginPath();
    ctx.arc(d.x, d.y, Math.max(0.4, d.r), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

function redraw() {
  if (!paperImg) paperImg = paper(drawing.paper);
  ctx.putImageData(paperImg, 0, 0);
  paint(drawingOps(drawing));
}

function fit() {
  const panel = view ? 120 : 190;
  const k = Math.min((innerWidth * 0.9) / SRC_W, (innerHeight - panel) / SRC_H);
  canvas.style.width = SRC_W * k + "px";
  canvas.style.height = SRC_H * k + "px";
}
addEventListener("resize", fit);

// ---------------------------------------------------------------------------
// ovládání

function ui() {
  if (!cur) return;
  const b = cur.brush;
  const tools = $("tools");
  tools.innerHTML = "";
  for (const t of cur.msg.tools) {
    const el = document.createElement("button");
    el.textContent = TOOL_NAMES[t];
    el.className = "k-btn k-btn--ghost" + (b.tool === t ? " on" : "");
    el.onclick = () => {
      b.tool = t;
      if ((t === TOOL.pen || t === TOOL.brush) && !b.a && cur!.msg.inks.length) b.a = 1;
      sync();
    };
    tools.appendChild(el);
  }
  const inks = $("inks");
  inks.innerHTML = "";
  cur.msg.inks.forEach((ink, i) => {
    if (ink.pick === false) return; // předloha (volná relace) se nevybírá
    const el = document.createElement("span");
    el.className = "ink" + (b.a === i + 1 ? " a" : b.b === i + 1 ? " b" : "") + ((cur!.drops[i] ?? 0) < 0.5 ? " empty" : "");
    el.style.background = hex(rgbInt(ink.rgb));
    el.title = ink.name;
    el.textContent = cur!.msg.unlimited ? "" : String(Math.floor(cur!.drops[i] ?? 0));
    el.onclick = () => {
      if (mixing && b.a && b.a !== i + 1) b.b = b.b === i + 1 ? 0 : i + 1;
      else {
        b.a = i + 1;
        if (b.b === i + 1) b.b = 0;
        if (b.tool === TOOL.charcoal || b.tool === TOOL.scrape) b.tool = cur!.msg.tools.includes(TOOL.pen) ? TOOL.pen : TOOL.brush;
      }
      sync();
    };
    inks.appendChild(el);
  });
  $("mix").classList.toggle("on", mixing);
  $("mix").classList.toggle("hidden", cur.msg.inks.length < 2);
  $("ratioL").classList.toggle("hidden", !(mixing && b.b));
  $("status").textContent = cur.status || "Kresli myší po listu.";
}

function sync() {
  if (!cur) return;
  send("kresby:brush", cur.brush);
  ui();
}

const sizeOf = (v: number) => Math.round(2 * 80 ** (v / 1000));
$<HTMLInputElement>("size").oninput = (e) => cur && ((cur.brush.size = sizeOf(+(e.target as HTMLInputElement).value)), sync());
$<HTMLInputElement>("op").oninput = (e) => cur && ((cur.brush.op = +(e.target as HTMLInputElement).value), sync());
$<HTMLInputElement>("ratio").oninput = (e) => cur && ((cur.brush.mix = +(e.target as HTMLInputElement).value), sync());
$("mix").onclick = () => {
  mixing = !mixing;
  if (!mixing && cur) cur.brush.b = 0;
  sync();
};
$("undo").onclick = () => send("kresby:undo");
$("done").onclick = () => send("kresby:finish", { title: $<HTMLInputElement>("name").value.trim() || cur?.msg.title || "Kresba" });
let cancelAt = 0;
$("cancel").onclick = () => {
  if (Date.now() - cancelAt < 3000) send("kresby:cancel");
  else {
    cancelAt = Date.now();
    $("status").textContent = "Ještě jednou = list zůstane čistý, inkoust se nespotřebuje.";
  }
};
$("close").onclick = () => send("kresby:close");
addEventListener("keydown", (e) => {
  if (e.key === "Escape") (view ? send("kresby:close") : $("cancel").click());
  else if ((e.key === "z" || e.key === "Backspace") && !view && document.activeElement !== $("name")) send("kresby:undo");
});

// tah myší
let pts: number[] = [];
let last = 0;
let pr = 1;
function pos(e: PointerEvent) {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * SRC_W, ((e.clientY - r.top) / r.height) * SRC_H];
}
function color() {
  const b = cur!.brush;
  if (b.tool === TOOL.charcoal) return "#221f1e";
  if (b.tool === TOOL.scrape) return hex(rgbInt(paperOf(drawing.paper).rgb));
  const A = cur!.msg.inks[b.a - 1];
  const B = b.b ? cur!.msg.inks[b.b - 1] : null;
  return A ? hex(rgbInt(B ? mixRGB(A.rgb, B.rgb, b.mix / 255) : A.rgb)) : "#221f1e";
}
canvas.onpointerdown = (e) => {
  if (!cur || view) return;
  if (e.button === 2) return send("kresby:undo");
  canvas.setPointerCapture(e.pointerId);
  const [x, y] = pos(e);
  pts = [Math.round(x), Math.round(y), 15];
  pr = 1;
  last = performance.now();
};
canvas.onpointermove = (e) => {
  if (!pts.length || !cur) return;
  const [x, y] = pos(e);
  const n = pts.length;
  const d = Math.hypot(x - pts[n - 3], y - pts[n - 2]);
  if (d < 1.2) return;
  const t = performance.now();
  pr = pr * 0.75 + Math.max(0.2, Math.min(1, 1.15 - (d / Math.max(1, t - last)) * 0.55)) * 0.25;
  last = t;
  ctx.globalAlpha = cur.brush.op / 255;
  ctx.strokeStyle = color();
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(0.5, (cur.brush.size / 4) * (PRESSURE[cur.brush.tool] ?? PRESSURE[0])(pr));
  ctx.beginPath();
  ctx.moveTo(pts[n - 3], pts[n - 2]);
  ctx.lineTo(x, y);
  ctx.stroke();
  ctx.globalAlpha = 1;
  pts.push(Math.round(x), Math.round(y), Math.round(pr * 15));
  // dlouhý tah po kusech (nejvýš 4 096 bodů na zprávu), navazuje posledním bodem
  if (pts.length >= 3 * 4096) {
    send("kresby:stroke", { p: pts, brush: cur.brush });
    pts = pts.slice(-3);
  }
};
canvas.onpointerup = () => {
  if (!pts.length || !cur) return;
  send("kresby:stroke", { p: pts, brush: cur.brush });
  pts = [];
};
canvas.oncontextmenu = (e) => e.preventDefault();

// ---------------------------------------------------------------------------
// zprávy ze skriptu

function load(d: string | null) {
  const dr = d ? decode(d, 16) : null;
  drawing = dr ?? { paper: 0, inks: [], strokes: [] };
}

addEventListener("kresby:canvas", (e) => {
  const m = (e as CustomEvent).detail as Msg;
  view = false;
  cur = m;
  load(m.d);
  drawing.paper = m.msg.paper;
  drawing.inks = m.msg.inks.map((i) => ({ rgb: i.rgb, flags: i.flags, strength: i.strength }));
  paperImg = null;
  $("title").classList.add("hidden");
  $("author").classList.add("hidden");
  $("panel").classList.remove("hidden");
  $("viewbar").classList.add("hidden");
  $<HTMLInputElement>("name").value = m.msg.title === "Kresba" ? "" : m.msg.title;
  wrap.style.display = "flex";
  fit();
  redraw();
  ui();
});

addEventListener("kresby:result", (e) => {
  const r = (e as CustomEvent).detail as { why: string | null; drops: number[]; charcoal: number; status: string };
  if (!cur) return;
  Object.assign(cur, { drops: r.drops, charcoal: r.charcoal, status: r.why || r.status });
  ui();
});

addEventListener("kresby:state", (e) => {
  const r = (e as CustomEvent).detail as { d: string; drops: number[]; charcoal: number; status: string };
  if (!cur) return;
  const inks = drawing.inks;
  const before = drawing.strokes.length;
  load(r.d);
  drawing.inks = inks;
  drawing.paper = cur.msg.paper;
  Object.assign(cur, { drops: r.drops, charcoal: r.charcoal, status: r.status });
  if (drawing.strokes.length === before + 1) {
    const ops: Ops = { runs: [], dots: [], segments: 0 };
    strokeOps(drawing.strokes[before], drawing, before + 1, 0, ops);
    paint(ops);
  } else redraw();
  ui();
});

addEventListener("kresby:view", (e) => {
  const v = (e as CustomEvent).detail as { title: string; author: string; d: string };
  view = true;
  cur = null;
  load(v.d);
  paperImg = null;
  $("title").textContent = v.title;
  $("title").classList.remove("hidden");
  $("author").textContent = v.author ? "Podepsáno: " + v.author : "Nepodepsáno";
  $("author").classList.remove("hidden");
  $("panel").classList.add("hidden");
  $("viewbar").classList.remove("hidden");
  wrap.style.display = "flex";
  fit();
  redraw();
});

send("kresby:ready");
