// Náhled kresby ve světě bez hry: vykreslí ukázkovou kresbu stejnou cestou jako server (rastr -> DDS BC1 s mipmapami),
// texturu přečte zpět z DDS (jak ji dostane hra) a složí tři pohledy na vývěsku z 1, 3 a 8 m: mipmapa podle vzdálenosti,
// rozptýlené světlo pod úhlem a stín listu na dřevě. Je to simulace osvětlení, ne snímek ze hry.
//
//   node tools/build.mjs && npx esbuild tools/nahled.ts --bundle --platform=node --outfile=dist/nahled.cjs && node dist/nahled.cjs [výstup.png]
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import type { Drawing, Stroke } from "../src/shared/codec";
import { readDds, writeDds } from "../src/server/dds";
import { renderSheet, resample, runSync, type Canvas } from "../src/server/raster";

// ukázková kresba: hrad na kopci, slunce, nápis (tahy brkem, štětcem, uhlem, zlato)
function demo(): Drawing {
  const inks: Drawing["inks"] = [
    { rgb: [38, 30, 28], flags: 0, strength: 245 },
    { rgb: [150, 38, 30], flags: 0, strength: 230 },
    { rgb: [50, 85, 150], flags: 0, strength: 235 },
    { rgb: [212, 170, 60], flags: 3, strength: 255 },
    { rgb: [86, 112, 52], flags: 0, strength: 220 },
  ];
  const S: Stroke[] = [];
  const line = (tool: number, a: number, size: number, pts: number[][], pr = 13, op = 255) => S.push({ tool, a, b: 0, mix: 0, size, op, p: pts.flatMap(([x, y], i) => [Math.round(x), Math.round(y), Math.round(pr - (i % 5 === 4 ? 4 : 0))]) });
  const seg = (x0: number, y0: number, x1: number, y1: number, n = 12) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
  // kopec štětcem zeleně
  line(1, 5, 60, Array.from({ length: 40 }, (_, i) => [40 + i * 18, 430 - Math.sin(i / 6) * 40]), 15, 200);
  // hrad: zdi a věže brkem
  for (const [x0, y0, x1, y1] of [[250, 380, 250, 230], [250, 230, 520, 230], [520, 230, 520, 380], [300, 230, 300, 150], [300, 150, 350, 150], [350, 150, 350, 230], [430, 230, 430, 130], [430, 130, 490, 130], [490, 130, 490, 230], [360, 380, 360, 320], [360, 320, 410, 320], [410, 320, 410, 380]]) line(0, 1, 9, seg(x0, y0, x1, y1));
  for (let x = 300; x <= 350; x += 12) line(0, 1, 7, seg(x, 150, x, 138, 3));
  for (let x = 430; x <= 490; x += 12) line(0, 1, 7, seg(x, 130, x, 118, 3));
  // praporec zlatem a červení
  line(0, 4, 8, seg(460, 118, 460, 70, 6));
  line(1, 2, 20, seg(462, 74, 510, 86, 6), 15, 220);
  // slunce a nebe
  line(1, 4, 40, Array.from({ length: 25 }, (_, i) => [640 + Math.cos(i / 4) * 40, 90 + Math.sin(i / 4) * 40]), 15, 220);
  line(1, 3, 30, Array.from({ length: 30 }, (_, i) => [60 + i * 15, 60 + Math.sin(i / 3) * 10]), 12, 120);
  // stínování uhlem
  for (let i = 0; i < 8; i++) line(2, 0, 14, seg(470 + i * 6, 240, 455 + i * 6, 370, 8), 9);
  // nápis brkem (kurzíva)
  const word = [[60, 490], [75, 465], [85, 495], [100, 470], [110, 495], [125, 468], [140, 495], [150, 470], [168, 497], [180, 468], [192, 495]];
  line(0, 1, 7, word, 12);
  return { paper: 0, inks, strokes: S };
}

function png(c: Canvas): Buffer {
  const raw = Buffer.alloc((c.w * 3 + 1) * c.h);
  for (let y = 0; y < c.h; y++) {
    raw[y * (c.w * 3 + 1)] = 0;
    for (let x = 0; x < c.w * 3; x++) raw[y * (c.w * 3 + 1) + 1 + x] = Math.max(0, Math.min(255, Math.round(c.px[y * c.w * 3 + x])));
  }
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let k = n;
    for (let i = 0; i < 8; i++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1;
    return k >>> 0;
  });
  const crc = (b: Buffer) => {
    let x = 0xffffffff;
    for (const v of b) x = crcT[(x ^ v) & 255] ^ (x >>> 8);
    return (x ^ 0xffffffff) >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const cr = Buffer.alloc(4);
    cr.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const sample = (c: Canvas, u: number, v: number) => {
  // bilineárně, jako vzorkovač textury
  const x = Math.max(0, Math.min(c.w - 1.001, u * c.w - 0.5));
  const y = Math.max(0, Math.min(c.h - 1.001, v * c.h - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const out = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const p = (xx: number, yy: number) => c.px[(yy * c.w + xx) * 3 + ch];
    out[ch] = (p(x0, y0) * (1 - fx) + p(x0 + 1, y0) * fx) * (1 - fy) + (p(x0, y0 + 1) * (1 - fx) + p(x0 + 1, y0 + 1) * fx) * fy;
  }
  return out;
};

function main() {
  const out = process.argv[2] ?? "docs/nahled-svet.png";
  const tex = resample(runSync(renderSheet(demo(), (2 * 1024) / 768 / 1.5)), 1024, 512);
  const dds = writeDds(tex);
  const W = 900;
  const H = 420;
  const img: Canvas = { w: W, h: H, px: new Float32Array(W * H * 3) };
  // tři pohledy: list (0,46 m) zabírá podle vzdálenosti (svislé zorné pole 55°, obrazovka 1080 px)
  const views = [{ d: 1, x: 20 }, { d: 3, x: 590 }, { d: 8, x: 800 }];
  for (const vw of views) {
    const pxPerM = 1080 / (2 * vw.d * Math.tan((27.5 * Math.PI) / 180));
    const sw = Math.round(0.46 * pxPerM);
    const sh = Math.round(sw / 1.5);
    const mip = Math.max(0, Math.min(dds.mips - 1, Math.round(Math.log2(1024 / sw))));
    const m = readDds(dds.files, mip);
    const ox = vw.x;
    const oy = 40;
    const pad = Math.round(sw * 0.12);
    // dřevo vývěsky, stín listu (posun vpravo dolů), list osvětlený zleva shora
    for (let y = oy - pad; y < oy + sh + pad; y++) {
      for (let x = ox - pad; x < ox + sw + pad; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const o = (y * W + x) * 3;
        const g = 0.85 + 0.15 * Math.sin(y * 0.35 + Math.sin(x * 0.02) * 3);
        let c = [74 * g, 52 * g, 33 * g];
        const sx = x - ox - Math.max(2, sw * 0.015);
        const sy = y - oy - Math.max(2, sw * 0.02);
        if (sx >= 0 && sy >= 0 && sx < sw && sy < sh) c = c.map((v) => v * 0.55);
        if (x >= ox && y >= oy && x < ox + sw && y < oy + sh) {
          const t = sample(m, (x - ox + 0.5) / sw, (y - oy + 0.5) / sh);
          const lit = 0.32 + 0.68 * (0.92 - 0.12 * ((x - ox) / sw) - 0.08 * ((y - oy) / sh)); // rozptýlené světlo a okolí
          c = t.map((v) => v * lit);
        }
        img.px.set(c, o);
      }
    }
    console.log(`${vw.d} m: list ${sw}×${sh} px na obrazovce, mipmapa ${mip} (${m.w}×${m.h})`);
  }
  writeFileSync(out, png(img));
  console.log(`náhled: ${out}, textura ${(dds.bytes / 1024).toFixed(0)} kB`);
}
main();
