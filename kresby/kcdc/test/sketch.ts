// Umělá "ruční" kresba pro testy a měření: plynulé tahy s rozkmitem, různé nástroje a inkousty,
// vzorkované jako myš (1-4 px na bod).
import type { Drawing, Stroke } from "../src/shared/codec";

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function sketch(strokes: number, seed: number, pointsPer = 40): Drawing {
  const r = rng(seed);
  const d: Drawing = {
    paper: seed % 2,
    inks: [
      { rgb: [38, 30, 28], flags: 0, strength: 245 },
      { rgb: [150, 38, 30], flags: 0, strength: 230 },
      { rgb: [50, 85, 150], flags: 0, strength: 235 },
      { rgb: [212, 170, 60], flags: 3, strength: 255 },
    ],
    strokes: [],
  };
  for (let i = 0; i < strokes; i++) {
    const tool = r() < 0.7 ? 0 : r() < 0.6 ? 1 : r() < 0.8 ? 2 : 3;
    const inked = tool < 2;
    const s: Stroke = { tool, a: inked ? 1 + Math.floor(r() * 4) : 0, b: 0, mix: 0, size: inked ? 4 + Math.floor(r() * 30) : 12, op: 160 + Math.floor(r() * 95), p: [] };
    if (inked && r() < 0.15) (s.b = s.a === 1 ? 2 : 1), (s.mix = Math.floor(r() * 255));
    let x = 40 + r() * 680;
    let y = 40 + r() * 430;
    let a = r() * Math.PI * 2;
    let pr = 10;
    const n = Math.max(2, Math.floor(pointsPer * (0.4 + r())));
    for (let k = 0; k < n; k++) {
      s.p.push(Math.round(Math.max(0, Math.min(767, x))), Math.round(Math.max(0, Math.min(511, y))), Math.round(pr));
      a += (r() - 0.5) * 0.35;
      const step = 1 + r() * 3;
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
      pr = Math.max(0, Math.min(15, pr + (r() - 0.5) * 2));
    }
    d.strokes.push(s);
  }
  return d;
}
