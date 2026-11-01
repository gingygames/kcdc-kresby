// Kodek a vektorové vykreslení: k2 kompatibilní s KCD:MP (kresby_png.lua přes lupa), k3 menší, odolnost proti
// rozbitým datům, LOD.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decode, encodeK2, encodeK3, hashOf, type Drawing } from "../src/shared/codec";
import { mixRGB, strokeArea } from "../src/shared/ink";
import { drawingOps, gizmoPlan, simplify } from "../src/shared/vector";
import { sketch } from "./sketch";

const lua = (req: object) =>
  JSON.parse(execFileSync("python", ["-I", join(import.meta.dirname, "..", "tools", "lua_k2.py")], { input: JSON.stringify(req), encoding: "utf8" }));

describe("kodek", () => {
  it("k2 je bajt po bajtu stejný jako v KCD:MP a Lua ho přečte", () => {
    const d = sketch(40, 1);
    const k2 = encodeK2(d);
    expect(lua({ encode: d }).k2).toBe(k2);
    const back = lua({ decode: k2 }).drawing;
    expect(back.strokes.length).toBe(d.strokes.length);
    expect(back.strokes[7].p).toEqual(d.strokes[7].p);
    expect(decode(k2)).toEqual(d);
  });

  it("k3 dekóduje totéž a je menší než k2", () => {
    const d = sketch(400, 2);
    const k2 = encodeK2(d);
    const k3 = encodeK3(d);
    expect(decode(k3)).toEqual(d);
    const ratio = k3.length / k2.length;
    console.log(`k2 ${k2.length} B, k3 ${k3.length} B (${Math.round(ratio * 100)} %), ${d.strokes.reduce((n, s) => n + s.p.length / 3, 0)} bodů`);
    expect(ratio).toBeLessThan(0.75);
  });

  it("rozbitá a cizí data vrátí null, nespadnou", () => {
    const k3 = encodeK3(sketch(30, 3));
    for (let i = 0; i < 300; i++) {
      const pos = 3 + ((i * 7919) % (k3.length - 3));
      const bad = k3.slice(0, pos) + "ABCDEFGH+/"[i % 10] + k3.slice(pos + 1);
      const d = decode(bad);
      if (d) for (const s of d.strokes) expect(s.p.length % 3).toBe(0);
    }
    expect(decode("k3.")).toBeNull();
    expect(decode("k9.AAAA")).toBeNull();
    expect(decode(42)).toBeNull();
    expect(decode("k3." + "/".repeat(50))).toBeNull();
    expect(decode(k3.slice(0, k3.length / 2))).toBeNull();
  });

  it("otisk se liší i při malé změně", () => {
    const a = encodeK3(sketch(10, 4));
    const d = sketch(10, 4);
    d.strokes[3].p[0] += 1;
    expect(hashOf(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(hashOf(a)).not.toBe(hashOf(encodeK3(d)));
  });
});

describe("inkousty a vykreslení", () => {
  it("míchání jako barvy: modrá + žlutá = zelená", () => {
    const g = mixRGB([50, 85, 150], [205, 160, 40], 0.5);
    expect(g[1]).toBeGreaterThan(g[0]);
    expect(g[1]).toBeGreaterThan(g[2]);
  });

  it("plocha tahu jako v KCD:MP (tečka i čára)", () => {
    expect(strokeArea({ tool: 0, a: 1, b: 0, mix: 0, size: 8, op: 255, p: [10, 10, 15] })).toBe(4);
    expect(strokeArea({ tool: 0, a: 1, b: 0, mix: 0, size: 8, op: 255, p: [0, 0, 15, 100, 0, 15] })).toBeCloseTo(204, 5);
  });

  it("zjednodušení drží konce a s tolerancí ubírá body", () => {
    const p: number[] = [];
    for (let i = 0; i <= 100; i++) p.push(i * 3, 100 + Math.sin(i / 10) * 20, 12);
    const s = simplify(p, 1.5);
    expect(s.slice(0, 3)).toEqual(p.slice(0, 3));
    expect(s.slice(-3)).toEqual(p.slice(-3));
    expect(s.length).toBeLessThan(p.length / 3);
  });

  it("efekty: štětec dvě vrstvy, uhel roztřesená vrstva, brk šířka podle přítlaku", () => {
    const d: Drawing = { paper: 0, inks: [{ rgb: [50, 85, 150], flags: 0, strength: 235 }], strokes: [
      { tool: 1, a: 1, b: 0, mix: 0, size: 40, op: 255, p: [0, 0, 15, 50, 0, 15, 100, 10, 15] },
      { tool: 2, a: 0, b: 0, mix: 0, size: 12, op: 255, p: [0, 50, 15, 50, 50, 8, 100, 60, 8] },
      { tool: 0, a: 1, b: 0, mix: 0, size: 12, op: 255, p: [0, 100, 15, 50, 100, 8, 100, 110, 2] },
    ] };
    const o = drawingOps(d);
    expect(o.runs.length).toBe(5);
    const pen = o.runs[4];
    expect(pen.w[1]).not.toBe(pen.w[0]);
    expect(o.runs[3].pts[0]).not.toBe(0); // roztřesená vrstva uhlu
  });

  it("LOD Gizmos: na dálku řádově méně úseků i kreseb", () => {
    const d = sketch(300, 5);
    const near = gizmoPlan(d, 0, 0, 0.35); // ~1 m: list přes půl obrazovky
    const mid = gizmoPlan(d, 1, 0.6, 2); // ~5 m
    const far = gizmoPlan(d, 3, 1.8, 6); // ~14 m
    console.log(`Gizmos úseků: plná ${near.units} (${near.ids} kreseb), střední ${mid.units} (${mid.ids}), daleko ${far.units} (${far.ids})`);
    expect(mid.units).toBeLessThan(near.units * 0.6);
    expect(far.units).toBeLessThan(mid.units);
    expect(mid.ids).toBeLessThanOrEqual(48);
    expect(far.ids).toBeLessThanOrEqual(24);
  });
});
