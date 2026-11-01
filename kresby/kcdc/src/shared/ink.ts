// Inkousty a spotřeba - stejné vzorce jako server KCD:MP (kresby_png.lua, kresby_materials.lua), sdílí je server i klient.

import { TOOL, type Ink, type Stroke } from "./codec";

import { LOOK, type RGB } from "./look";
export type { RGB } from "./look";

/**
 * Míchání barev, t = podíl druhé barvy 0..1. "pigment" (výchozí): vážený geometrický průměr odrazivosti, chová se jako
 * barvy (modrá + žlutá = zelená); "svetlo": lineární průměr (jako světlo, šedší). Volí se v nastavení.
 */
export function mixRGB(a: RGB, b: RGB, t: number): RGB {
  const out: RGB = [0, 0, 0];
  if (LOOK.mix === "svetlo") {
    for (let i = 0; i < 3; i++) out[i] = Math.round(a[i] * (1 - t) + b[i] * t);
    return out;
  }
  for (let i = 0; i < 3; i++) {
    const x = Math.max(a[i], 1) / 255;
    const y = Math.max(b[i], 1) / 255;
    out[i] = Math.floor(255 * x ** (1 - t) * y ** t + 0.5);
  }
  return out;
}

/** šířka tahu podle přítlaku (0..1) */
export const PRESSURE: ((pr: number) => number)[] = [
  (pr) => 0.3 + 0.7 * pr, // brk
  (pr) => 0.55 + 0.45 * pr, // štětec
  (pr) => 0.7 + 0.3 * pr, // uhel
  () => 1, // škrabka
];

/** plocha tahu v logických px² (váha přítlaku), i tečka něco stojí */
export function strokeArea(s: Stroke): number {
  const p = s.p;
  const w = s.size / 4;
  const press = PRESSURE[s.tool] ?? PRESSURE[0];
  let area = 0;
  for (let i = 3; i + 2 < p.length; i += 3) {
    const dx = p[i] - p[i - 3];
    const dy = p[i + 1] - p[i - 2];
    area += Math.sqrt(dx * dx + dy * dy) * w * press((p[i + 2] + p[i - 1]) / 30);
  }
  return area + w * w;
}

/** kapky na plochu (při plném krytí a sytosti dropArea px² = 1 kapka) */
export function dropsFor(area: number, op: number, strength: number, dropArea: number): number {
  return (area * (op / 255) * (strength / 255)) / dropArea;
}

/** spotřeba jednoho tahu: kapky z inkoustu a / b, uhel v px² */
export function strokeUse(s: Stroke, inks: Ink[], dropArea: number): { a: number; b: number; charcoal: number } {
  const area = strokeArea(s);
  if (s.tool === TOOL.charcoal) return { a: 0, b: 0, charcoal: area };
  if (s.tool === TOOL.scrape) return { a: 0, b: 0, charcoal: 0 };
  const A = inks[s.a - 1];
  const B = s.b ? inks[s.b - 1] : undefined;
  const t = B ? s.mix / 255 : 0;
  const da = A ? dropsFor(area * (1 - t), s.op, A.strength, dropArea) : 0;
  const db = B ? dropsFor(area * t, s.op, B.strength, dropArea) : 0;
  return { a: da, b: db, charcoal: 0 };
}

export const CHARCOAL_RGB: RGB = [34, 31, 30];

/** druhy listu: z nastavení (shared/look.ts), indexované kódem papíru */
export { PAPERS, paperOf } from "./look";

/** barva a skládání tahu: mode 0 = násobit (průhledný inkoust), 1 = navrch (krycí, zlatý, uhel), 2 = seškrábat */
export function strokeInk(s: Stroke, inks: Ink[]): { rgb: RGB; mode: 0 | 1 | 2; strength: number; gold: boolean; even?: boolean } {
  if (s.tool === TOOL.charcoal) return { rgb: CHARCOAL_RGB, mode: 1, strength: 1, gold: false };
  if (s.tool === TOOL.scrape) return { rgb: [0, 0, 0], mode: 2, strength: 1, gold: false };
  const A = inks[s.a - 1];
  if (!A) return { rgb: CHARCOAL_RGB, mode: 0, strength: 1, gold: false };
  const B = s.b ? inks[s.b - 1] : undefined;
  const t = B ? s.mix / 255 : 0;
  const rgb = B ? mixRGB(A.rgb, B.rgb, t) : A.rgb;
  const flags = t < 0.5 || !B ? A.flags || 0 : B.flags || 0;
  const strength = ((A.strength ?? 255) * (1 - t) + (B ? (B.strength ?? 255) : 0) * t) / 255;
  // even: rovnoměrný tah (příznak 4) - sázené písmo a křída: bez kaněk, ztenčených konců a slábnutí inkoustu
  return { rgb, mode: flags & 3 ? 1 : 0, strength, gold: (flags & 2) === 2, even: (flags & 4) === 4 };
}

/** výsledek smíchání dvou inkoustů v poměru (t = podíl B) - jako kniha v KCD:MP */
export function mixInks(A: Ink, B: Ink, t: number): Ink {
  let flags = 0;
  if ((A.flags & 1) * (1 - t) + (B.flags & 1) * t >= 0.5) flags |= 1;
  if (((A.flags & 2) / 2) * (1 - t) + ((B.flags & 2) / 2) * t >= 0.6) flags |= 3;
  return { rgb: mixRGB(A.rgb, B.rgb, t), flags, strength: Math.floor(A.strength * (1 - t) + B.strength * t + 0.5) };
}

const COLOR_NAMES: [string, number, number, number][] = [
  ["černá", 25, 22, 20], ["hnědočerná", 60, 42, 32], ["hnědá", 110, 70, 40], ["sépiová", 112, 74, 34],
  ["okrová", 190, 140, 60], ["žlutá", 220, 180, 50], ["oranžová", 210, 110, 40], ["červená", 160, 40, 30],
  ["rumělková", 205, 60, 40], ["růžová", 210, 130, 140], ["purpurová", 110, 40, 90], ["fialová", 90, 60, 130],
  ["modrá", 50, 85, 150], ["tmavomodrá", 30, 45, 90], ["zelenomodrá", 40, 110, 120], ["zelená", 70, 120, 60],
  ["olivová", 110, 110, 50], ["šedá", 120, 120, 115], ["bílá", 236, 230, 214],
];

export function colorName(rgb: RGB, flags = 0): string {
  if (flags & 2) return "zlatá";
  let best = "černá";
  let bd = Infinity;
  for (const [name, r, g, b] of COLOR_NAMES) {
    const d = (rgb[0] - r) ** 2 + (rgb[1] - g) ** 2 + (rgb[2] - b) ** 2;
    if (d < bd) {
      best = name;
      bd = d;
    }
  }
  return best;
}

export function inkKind(flags: number): string {
  if (flags & 2) return "zlatý";
  if (flags & 1) return "krycí";
  return "průhledný";
}

export const rgbInt = (c: RGB) => (c[0] << 16) | (c[1] << 8) | c[2];
