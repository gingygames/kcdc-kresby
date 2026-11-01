// Strom clipů falešného Scaleformu (test/fake.ts) jako SVG: kreslicí volání (lineStyle / moveTo / lineTo / curveTo /
// beginFill / endFill) a textová pole. Pro snímky UI bez hry (tools/nahled-ui.mjs). Písma jsou náhradní (hra má vlastní).
import type { Clip } from "./fake";

const hex = (n: number) => "#" + (n & 0xffffff).toString(16).padStart(6, "0");
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const f = (n: number) => Math.round(n * 100) / 100;

function clipSvg(c: Clip): string {
  if (c.props.visible === false || !c.valid) return "";
  const p = c.props;
  let out = `<g transform="translate(${f(p.x ?? 0)} ${f(p.y ?? 0)}) scale(${f(p.scaleX ?? 1)} ${f(p.scaleY ?? 1)})"${p.alpha !== undefined ? ` opacity="${f(p.alpha)}"` : ""}>`;
  let stroke: { w: number; c: number; a: number } | null = null;
  let fill: { c: number; a: number; d: string } | null = null;
  let x = 0;
  let y = 0;
  let run = "";
  const flush = () => {
    if (run && stroke) out += `<path d="${run}" fill="none" stroke="${hex(stroke.c)}" stroke-opacity="${f(stroke.a / 100)}" stroke-width="${stroke.w}" stroke-linecap="round" stroke-linejoin="round"/>`;
    run = "";
  };
  for (const [m, ...a] of c.calls) {
    if (m === "lineStyle") {
      flush();
      stroke = a.length ? { w: a[0], c: a[1] ?? 0, a: a[2] ?? 100 } : null;
    } else if (m === "beginFill") {
      flush();
      fill = { c: a[0], a: a[1] ?? 100, d: "" };
    } else if (m === "endFill") {
      if (fill) out += `<path d="${fill.d}Z" fill="${hex(fill.c)}" fill-opacity="${f(fill.a / 100)}"/>`;
      fill = null;
    } else if (m === "moveTo") {
      [x, y] = a;
      if (fill) fill.d += `M${f(x)} ${f(y)}`;
      else run += `M${f(x)} ${f(y)}`;
    } else if (m === "lineTo" || m === "curveTo") {
      const seg = m === "lineTo" ? `L${f(a[0])} ${f(a[1])}` : `Q${f(a[0])} ${f(a[1])} ${f(a[2])} ${f(a[3])}`;
      if (fill) fill.d += (fill.d ? "" : `M${f(x)} ${f(y)}`) + seg;
      else if (stroke) run += (run ? "" : `M${f(x)} ${f(y)}`) + seg;
      [x, y] = m === "lineTo" ? a : [a[2], a[3]];
    }
  }
  flush();
  if (c.style.isText) {
    const s = c.style;
    const w = p.width ?? 200;
    if (c.members.background) out += `<rect width="${w}" height="${p.height ?? 20}" fill="${hex(c.members.backgroundColor ?? 0xffffff)}"${c.members.border ? ' stroke="#5a4a35"' : ""}/>`;
    const size = s.size ?? 16;
    const anchor = s.align === "center" ? "middle" : s.align === "right" ? "end" : "start";
    const tx = s.align === "center" ? w / 2 : s.align === "right" ? w - 2 : 2;
    const family = s.font === "Manuscript" ? "'Palatino Linotype', Georgia, serif" : "Georgia, 'Times New Roman', serif";
    const lines = String(c.text ?? "").split("\n");
    lines.forEach((t, i) => {
      out += `<text x="${f(tx)}" y="${f(size * (1 + i * 1.25))}" font-family="${family}"${s.font === "Manuscript" ? ' font-style="italic"' : ""}${s.bold ? ' font-weight="bold"' : ""} font-size="${size}" fill="${hex(s.color ?? 0xffffff)}" text-anchor="${anchor}">${esc(t)}</text>`;
    });
  }
  for (const ch of c.children) out += clipSvg(ch);
  return out + "</g>";
}

/** obrazovka 1920 × 1080 nad pozadím (dřevo vývěsky, na kterou je kamera zamčená) */
export function screenSvg(root: Clip, backdrop = woodBackdrop()): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">${backdrop}${clipSvg(root)}</svg>`;
}

export function woodBackdrop() {
  let g = `<defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b2a1b"/><stop offset="1" stop-color="#22170e"/></linearGradient></defs><rect width="1920" height="1080" fill="url(#w)"/>`;
  for (let i = 0; i < 60; i++) {
    const y = i * 18 + ((i * 37) % 11);
    g += `<path d="M0 ${y} C 500 ${y + 6}, 1300 ${y - 6}, 1920 ${y + 3}" stroke="#1a110a" stroke-opacity="0.35" stroke-width="${1 + (i % 3)}" fill="none"/>`;
  }
  return g;
}
