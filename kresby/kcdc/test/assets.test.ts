// Kresby ve světě jako textura: rastr (efekty), DDS hry (BC1 sRGB, dělené mipmapy), model listu CGF/CGFM, balíčky
// assetů (resource kresby-obrazy-N) a jejich přenačtení, Prop s modelem kresby, čtení na desce kamerou.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeK3 } from "../src/shared/codec";
import { EV } from "../src/shared/protocol";
import { sheetMaterial, sheetModel } from "../src/server/cgf";
import { decodeBC1, encodeBC1, readDds, writeDds } from "../src/server/dds";
import { renderSheet, resample, runSync, type Canvas } from "../src/server/raster";
import { quatFromBasis } from "../src/shared/layout";
import { world } from "./fake";
import { sketch } from "./sketch";

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const lum = (c: Canvas, x: number, y: number) => {
  const i = (Math.floor(y) * c.w + Math.floor(x)) * 3;
  return c.px[i] * 0.299 + c.px[i + 1] * 0.587 + c.px[i + 2] * 0.114;
};

/** čtení CGF: tabulka bloků (jako tools ve hře, viz cgf.ts) */
function chunks(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  expect(String.fromCharCode(...b.subarray(0, 4))).toBe("CrCh");
  expect(v.getUint32(4, true)).toBe(0x746);
  const n = v.getUint32(8, true);
  const off = v.getUint32(12, true);
  return Array.from({ length: n }, (_, i) => ({ type: v.getUint16(off + i * 16, true), ver: v.getUint16(off + i * 16 + 2, true), id: v.getUint32(off + i * 16 + 4, true), size: v.getUint32(off + i * 16 + 8, true), off: v.getUint32(off + i * 16 + 12, true) }));
}

describe("textura kresby", () => {
  it("rastr: brk je tmavý na světlém pergamenu, kaňky a krycí běloba se kreslí", () => {
    const d = { paper: 0, inks: [{ rgb: [38, 30, 28] as [number, number, number], flags: 0, strength: 245 }, { rgb: [236, 230, 214] as [number, number, number], flags: 1, strength: 255 }], strokes: [
      { tool: 0, a: 1, b: 0, mix: 0, size: 16, op: 255, p: [100, 256, 15, 300, 256, 15, 600, 256, 15] },
      { tool: 1, a: 2, b: 0, mix: 0, size: 40, op: 255, p: [300, 100, 15, 300, 400, 15] },
    ] };
    const cv = runSync(renderSheet(d, 2));
    expect(cv.w).toBe(1536);
    expect(lum(cv, 400, 512)).toBeLessThan(90); // tah brkem (y = 256 logických px * 2)
    expect(lum(cv, 400, 300)).toBeGreaterThan(180); // papír
    expect(lum(cv, 600, 650)).toBeGreaterThan(lum(cv, 400, 512) + 80); // běloba přes brk
    const t = resample(cv, 1024, 512);
    expect(t.w).toBe(1024);
    expect(lum(t, 1024 * (400 / 768), 256)).toBeLessThan(110);
  });

  it("DDS jako hra: hlavička CryEngine, BC1 sRGB, mipmapy do 4 px rozdělené do .dds.1 … .dds.N", () => {
    const cv = resample(runSync(renderSheet(sketch(60, 3), 1.5)), 1024, 512);
    const dds = writeDds(cv);
    expect(dds.mips).toBe(8); // 1024×512 … 8×4
    expect([...dds.files.keys()].sort()).toEqual(["", "1", "2", "3", "4"]);
    expect(dds.files.get("4")!.length).toBe(1024 * 512 / 2); // plný rozměr, BC1 = 4 bity na pixel
    const base = dds.files.get("")!;
    const v = new DataView(base.buffer, base.byteOffset);
    expect(String.fromCharCode(...base.subarray(0, 4))).toBe("DDS ");
    expect(v.getUint32(0x24, true)).toBe(0x00200800);
    expect(String.fromCharCode(...base.subarray(0x54, 0x58))).toBe("DX10");
    expect(String.fromCharCode(...base.subarray(0x7c, 0x80))).toBe("FYRC");
    expect(base[0x74]).toBe(4); // trvalé mipmapy v .dds
    expect(v.getUint32(0x80, true)).toBe(72); // BC1_UNORM_SRGB
    expect(base.length).toBe(148 + (128 + 32 + 8 + 2) * 8); // bloky 4×4 mipmap 64×32, 32×16, 16×8, 8×4
    // zpět: plná mipmapa i nejmenší
    const full = readDds(dds.files, 0);
    let err = 0;
    for (let i = 0; i < full.px.length; i++) err += Math.abs(full.px[i] - cv.px[i]);
    expect(err / full.px.length).toBeLessThan(6); // BC1 je ztrátové, ale věrné
    expect(readDds(dds.files, 7).w).toBe(8);
    console.log(`textura 1024×512: ${(dds.bytes / 1024).toFixed(0)} kB, průměrná chyba BC1 ${(err / full.px.length).toFixed(2)}`);
  });

  it("BC1 blok: dvě barvy přesně", () => {
    const c: Canvas = { w: 4, h: 4, px: new Float32Array(48) };
    for (let i = 0; i < 16; i++) c.px.set(i < 8 ? [255, 255, 255] : [0, 0, 0], i * 3);
    const back = decodeBC1(encodeBC1(c), 4, 4);
    expect(back.px[0]).toBeGreaterThan(240);
    expect(back.px[47]).toBeLessThan(15);
  });

  it("model listu: CGF + CGFM jako modely hry, materiál s texturou", () => {
    const { cgf, cgfm } = sheetModel("objects/kcdc/kresby-obrazy-1/k12");
    expect(chunks(cgf).map((c) => c.type.toString(16))).toEqual(["1013", "100e", "1015", "1014", "1000", "100b"]);
    const m = chunks(cgfm);
    expect(m.map((c) => c.type.toString(16))).toEqual(["1014", "1017", "1016", "1016", "1016", "1000", "100b"]);
    const mtl = m[0];
    expect(String.fromCharCode(...cgfm.subarray(mtl.off, mtl.off + 32))).toContain("objects/kcdc/kresby-obrazy-1/k12");
    const mesh = new DataView(cgfm.buffer, m[5].off);
    expect([mesh.getInt32(8, true), mesh.getInt32(12, true)]).toEqual([8, 12]); // líc a rub: 8 vrcholů, 4 trojúhelníky
    expect(mesh.getInt32(28 + 15 * 4, true)).toBe(3); // proud P3S_C4B_T2S
    expect(mesh.getFloat32(108, true)).toBeCloseTo(-0.5); // šířka 1 m
    expect(mesh.getFloat32(124, true)).toBeCloseTo(1 / 3); // výška 2/3 m
    const x = sheetMaterial("textures/kcdc/kresby-obrazy-1/k12.dds");
    expect(x).toContain('Shader="Illum"');
    expect(x).toContain('MtlFlags="524416"'); // jednostranný (bez 0x2): zezadu je vidět rub, ne zrcadlená kresba
    expect(x).toContain('File="textures/kcdc/kresby-obrazy-1/k12.dds" Map="Diffuse"');
  });

  it("natočení listu: osa X modelu doprava, Z k divákovi", () => {
    // deska lícem k -Y: doprava = +X, nahoru = +Z
    const q = quatFromBasis([1, 0, 0], [0, 0, 1], [0, -1, 0]);
    // otočení o +90° kolem X: (w, x) = (cos 45°, sin 45°)
    expect(q[0]).toBeCloseTo(Math.SQRT1_2);
    expect(q[1]).toBeCloseTo(Math.SQRT1_2);
  });
});

describe("balíčky textur na serveru", () => {
  let dir = "";
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    dir = mkdtempSync(join(tmpdir(), "kresby-assets-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("pověšená kresba: vykreslí se, balíček se přenačte, list ve světě dostane model kresby; čtení kamerou bez překryvu", async () => {
    const w = world({ assetsDir: dir });
    const { s, c } = w;
    await s.start();
    await tick(10);
    // balíček 0 = prázdné listy (pergamen, papír)
    const blank = readdirSync(join(dir, "kresby-obrazy-0/stream/objects/kcdc/kresby-obrazy-0")).sort();
    expect(blank).toEqual([
      "list0.cgf", "list0.cgfm", "list0.mtl", "list1.cgf", "list1.cgfm", "list1.mtl", "list31.cgf", "list31.cgfm", "list31.mtl"]); // 31 = školní tabule (SYSTEM_PAPERS)
    expect(JSON.parse(readFileSync(join(dir, "kresby-obrazy-0/package.json"), "utf8"))).toMatchObject({ name: "kresby-obrazy-0", mafiahub: {} });
    await s.cmd(s.henry, "dat Henry sada");
    await s.cmd(s.henry, "tabule 3 2 1.5");
    await tick(6000); // přenačtení balíčku 0
    expect(s.reloads[0]).toEqual({ novych: ["kresby-obrazy-0"], zmenenych: [] });
    // kreslí se na list 0: čistý list jako Prop z balíčku 0
    const b = s.henry.last(EV.okoli).add[0];
    s.client(EV.pouzit, s.henry, { b: b.id, slot: 0 });
    await s.pick(s.henry, "Kreslit: Čistý pergamen");
    const cv = s.henry.last(EV.platno);
    s.client(EV.tahy, s.henry, { s: cv.s, seq: 1, d: encodeK3({ paper: 0, inks: [], strokes: [{ tool: 0, a: 1, b: 0, mix: 0, size: 12, op: 255, p: [50, 50, 15, 700, 450, 15] }] }) });
    await tick(10);
    expect(s.props.filter((x) => !x.destroyed).map((x) => x.model)).toEqual(["objects/kcdc/kresby-obrazy-0/list0.cgf"]);
    void s.client(EV.hotovo, s.henry, { s: cv.s, title: "Hrad" });
    await s.pick(s.henry, "Nechat viset (podepsat)");
    await tick(200);
    // textura je vykreslená, klienti ji ještě nemají: visí čistý list a klienti přes něj kreslí tahy čarami
    const id = s.hans.last(EV.deska).slots[0].d as number;
    const tex = readdirSync(join(dir, "kresby-obrazy-1/stream/textures/kcdc/kresby-obrazy-1")).sort();
    expect(tex).toEqual([`k${id}.dds`, `k${id}.dds.1`, `k${id}.dds.2`, `k${id}.dds.3`, `k${id}.dds.4`]);
    expect(s.hans.last(EV.deska).slots[0].o).toBeUndefined();
    expect(s.hans.last(EV.deska).slots[0].pend).toBe(1); // klienti ji zatím ukazují čarami
    expect(s.props.filter((x) => !x.destroyed).map((x) => x.model)).toEqual(["objects/kcdc/kresby-obrazy-0/list0.cgf"]); // čistý list, tahy přes něj čarami (pend)
    // přenačtení (hák svet.reload) -> resourceStart -> list s kresbou
    await tick(6000);
    expect(s.reloads.at(-1)).toEqual({ novych: ["kresby-obrazy-1"], zmenenych: [] });
    const live = s.props.filter((x) => !x.destroyed);
    expect(live.map((x) => x.model)).toEqual([`objects/kcdc/kresby-obrazy-1/k${id}.cgf`]);
    expect(s.hans.last(EV.deska).slots[0]).toMatchObject({ o: "kresby-obrazy-1", d: id });
    expect(s.hans.last(EV.deska).slots[0].pend).toBeUndefined(); // textura je v balíčku: čáry pryč
    expect(s.logs.join("\n")).not.toMatch(/textura kresby .*Error/);

    // čtení na desce: kamera na list; textura u hráče = žádný překryv, Esc vrátí kameru
    const hans = c(s.hans);
    hans.assets.add(`textures/kcdc/kresby-obrazy-1/k${id}.dds`);
    s.hans.position.x = 1;
    hans.pose.position.x = 1;
    hans.ray.dir.x = -0.5; // na list 0 (vlevo)
    await tick(250);
    [...hans.hints.values()].at(-1)!.handler();
    await s.settle();
    await s.pick(s.hans, "Prohlédnout");
    await tick(800);
    expect(hans.shots.at(-1)?.position).toBeTruthy();
    expect(hans.controls.off).toBe(1);
    expect(hans.screens).toHaveLength(0); // čte se ve světě
    expect(hans.notices.at(-1)).toContain("Hrad");
    hans.keys.get("escape")!();
    expect(hans.shots.at(-1)).toBeNull();
    expect(hans.controls.off).toBe(1); // ovládání až po přeletu kamery zpět (bez cuknutí)
    await tick(700);
    expect(hans.controls.off).toBe(0);

    // smazání kresby: soubory pryč, balíček se přenačte
    await s.cmd(s.henry, `vymazat ${id}`);
    expect(readdirSync(join(dir, "kresby-obrazy-1/stream/textures/kcdc/kresby-obrazy-1"))).toHaveLength(0);
    expect(s.props.filter((x) => !x.destroyed)).toHaveLength(0);
  });

  it("deska školy s bake:false: kresba visí bez textury (klienti ji kreslí čarami), boardBake ji upeče", async () => {
    const { s } = world({ assetsDir: dir });
    await s.start();
    await tick(6000);
    const x = (n: string) => s.exportsReg.get(n) as (...a: any[]) => any;
    const id = x("boardCreate")({ owner: "skola", pos: [0, 2, 1.6], n: [0, -1, 0], w: 1.6 });
    const d = encodeK3({ paper: 31, inks: [{ rgb: [236, 232, 220], flags: 1, strength: 255 }], strokes: [{ tool: 0, a: 1, b: 0, mix: 0, size: 12, op: 255, p: [50, 50, 15, 700, 450, 15] }] });
    const did = x("boardPut")(id, 0, d, { owner: "skola", bake: false });
    await tick(7000);
    expect(existsSync(join(dir, "kresby-obrazy-1"))).toBe(false); // nic se nepeklo
    expect(x("drawingReady")(did)).toBe(false);
    expect(x("boardBake")(id, 0, "skola")).toBe(true);
    await tick(7000);
    expect(x("drawingReady")(did)).toBe(true);
  });

  it("restart kresby: textury na disku se znovu nevykreslují, listy hned s kresbou", async () => {
    const w = world({ assetsDir: dir });
    const { s } = w;
    await s.start();
    await s.cmd(s.henry, "dat Henry sada");
    await s.cmd(s.henry, "tabule 3 2 1.5");
    await tick(6000);
    const b = s.henry.last(EV.okoli).add[0];
    s.client(EV.pouzit, s.henry, { b: b.id, slot: 1 });
    await s.pick(s.henry, "Kreslit: Arch papíru");
    const cv = s.henry.last(EV.platno);
    s.client(EV.tahy, s.henry, { s: cv.s, seq: 1, d: encodeK3({ paper: 1, inks: [], strokes: [{ tool: 2, a: 0, b: 0, mix: 0, size: 30, op: 255, p: [50, 50, 15, 700, 450, 8] }] }) });
    void s.client(EV.hotovo, s.henry, { s: cv.s, title: "" });
    await s.pick(s.henry, "Nechat viset (podepsat)");
    await tick(6500);
    await tick(2100);
    await s.stop();
    const w2 = world({ assetsDir: dir, storage: s.storage });
    for (const n of s.running) w2.s.running.add(n); // balíčky běží dál
    await w2.s.start();
    await tick(100);
    expect(w2.s.props.filter((x) => !x.destroyed).map((x) => x.model)[0]).toMatch(/^objects\/kcdc\/kresby-obrazy-1\/k\d+\.cgf$/);
    expect(w2.s.logs.join("\n")).not.toContain("textura kresby");
  });
});
