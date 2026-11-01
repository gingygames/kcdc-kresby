// Výkon se stovkami kreseb: 300 kreseb na 50 vývěskách v městě 200 × 200 m, 64 hráčů. Měří server (přepočet okolí,
// posílání dat, úložiště), klienta (LOD, rozpočet Gizmos, čas vykreslení) a kodek. Čísla se vypíšou (README).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countPoints, decode, encodeK2, encodeK3, hashOf } from "../src/shared/codec";
import { faceHeight, normalFromYaw } from "../src/shared/layout";
import { EV } from "../src/shared/protocol";
import { drawingOps, gizmoPlan } from "../src/shared/vector";
import { encodeBC1, writeDds, writeDdsSteps } from "../src/server/dds";
import { Budget, poolStats, release, renderSheet, resample, resampleSteps, runSync } from "../src/server/raster";
import { Painter, Pen, StrokeBlocks } from "../src/client/native";
import { makeClient, makeServer, Vec } from "./fake";
import { rng, sketch } from "./sketch";

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
// skutečný čas (falešné časovače posouvají performance.now i Date)
const now = () => Number(process.hrtime.bigint()) / 1e6;
const ms = (t0: number) => Math.round((now() - t0) * 100) / 100;

/** úložiště s 50 vývěskami 3 × 2 a 300 kreslbami (běžná hustota: 60-160 tahů, 2 000-7 000 bodů) */
function town() {
  const st = new Map<string, string>();
  const r = rng(7);
  let id = 1;
  let bytes = 0;
  let points = 0;
  for (let b = 0; b < 50; b++) {
    const bid = id++;
    const yaw = Math.floor(r() * 4) * 90;
    const slots = [];
    for (let i = 0; i < 6; i++) {
      const d = sketch(60 + Math.floor(r() * 100), bid * 10 + i, 45);
      const data = encodeK3(d);
      const did = id++;
      bytes += data.length;
      points += countPoints(d);
      const rec = { id: did, h: hashOf(data), d: data, t: "Kresba " + did, a: "Autor", u: "nick:Autor", s: true, p: d.paper, c: 0, n: countPoints(d) };
      st.set("kresby:kresba/" + did, JSON.stringify(rec));
      slots.push({ d: did, h: rec.h, t: rec.t, a: rec.a, u: rec.u, p: rec.p });
    }
    const pos = [(b % 10) * 20 - 90, Math.floor(b / 10) * 40 - 90, 1.6];
    st.set("kresby:deska/" + bid, JSON.stringify({ id: bid, kind: "deska", pos, n: normalFromYaw(yaw), w: 1.5, h: faceHeight(1.5, 3, 2), cols: 3, rows: 2, slots, by: "admin", c: 0 }));
  }
  st.set("kresby:meta", JSON.stringify({ v: 1, next: id }));
  return { st, bytes, points };
}

describe("výkon", () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }));
  afterEach(() => void vi.useRealTimers());

  it("kodek: kresba s 15 000 body (strop)", () => {
    const d = sketch(320, 9, 47);
    let t0 = now();
    const k3 = encodeK3(d);
    const enc = ms(t0);
    t0 = now();
    for (let i = 0; i < 10; i++) decode(k3);
    const dec = ms(t0) / 10;
    t0 = now();
    const plan = gizmoPlan(d, 1, 0.5, 1);
    const pl = ms(t0);
    console.log(`kodek: ${countPoints(d)} bodů, k2 ${encodeK2(d).length} B, k3 ${k3.length} B; zakódovat ${enc} ms, dekódovat ${dec} ms, plán Gizmos ${pl} ms (${plan.units} úseků)`);
    expect(dec).toBeLessThan(50);
  });

  it("server: 300 kreseb, 64 hráčů po městě", async () => {
    const { st, bytes, points } = town();
    const s = makeServer({ storage: st });
    const list = [];
    for (let i = 0; i < 64; i++) list.push(new s.Player(10 + i, "H" + i, new Vec((i % 8) * 25 - 90, Math.floor(i / 8) * 25 - 90, 0)));
    s.Player.list = list;
    let t0 = now();
    await s.start();
    const load = ms(t0);
    // přepočet okolí pro všechny hráče (běží každých streamMs)
    await tick(1000);
    t0 = now();
    for (let k = 0; k < 20; k++) {
      for (const p of list) p.position.x += 1.5;
      await tick(1000);
    }
    const stream = ms(t0) / 20;
    const sent = list.reduce((n, p) => n + p.all(EV.okoli).reduce((m: number, x: any) => m + JSON.stringify(x).length, 0), 0);
    const known = list.reduce((n, p) => n + p.all(EV.okoli).reduce((m: number, x: any) => m + x.add.length, 0), 0) / list.length;
    // jeden hráč chce všechny kresby z okolí
    const p = list[0];
    const hashes = p.all(EV.okoli).flatMap((m: any) => m.add.flatMap((b: any) => b.slots.map((x: any) => x?.h))).filter(Boolean);
    t0 = now();
    for (let i = 0; i < hashes.length; i += 8) await s.client(EV.chci, p, { h: hashes.slice(i, i + 8) });
    const serve = ms(t0);
    const got = p.all(EV.data).filter((d: any) => d.d).length;
    console.log(
      `server: 50 desek / 300 kreseb (${points} bodů, ${(bytes / 1024).toFixed(0)} kB k3, průměr ${(bytes / 300 / 1024).toFixed(1)} kB); ` +
        `start ${load} ms; přepočet okolí 64 hráčů ${stream} ms za průchod; popisy desek ${(sent / 1024 / 64).toFixed(1)} kB na hráče za 20 s ` +
        `(~${known.toFixed(0)} desek v dosahu); ${got}/${hashes.length} kreseb za ${serve} ms, zbytek limit ${256} kB/s`,
    );
    expect(stream).toBeLessThan(20);
    expect(got).toBeGreaterThan(0);
  });

  it("klient: 30-60 kreseb v dosahu, LOD a rozpočet Gizmos", async () => {
    const { st } = town();
    // režim čar: klient kreslí všechny kresby v dosahu (v režimu textura jsou to Prop serveru a klient by neměřil nic)
    const s = makeServer({ storage: st, config: { dataRate: 50 * 1024 * 1024, svet: { rezim: "cary" } } });
    await s.start();
    const me = s.henry;
    me.position = new Vec(-10, -60, 0);
    s.Player.list = [me];
    const c = makeClient((n, payload) => queueMicrotask(() => s.client(n, me, payload)), { pos: new Vec(-10, -60, 1.6) });
    me.client = (n, payload) => c.deliver(n, payload);
    await tick(1000);
    // první průchody: stahování dat na vyžádání (8 otisků na žádost, jedna po 250 ms)
    for (let i = 0; i < 40; i++) await tick(250);
    const times: number[] = [];
    const res: string[] = [];
    let drawnMax = 0;
    for (const [label, y, look] of [["u desky (1,5 m)", -88.9, 0], ["na náměstí (8 m)", -82, 0], ["procházka", -70, 1]] as const) {
      c.pose.position = new Vec(-10, y, 1.6);
      c.pose.forward = look ? new Vec(0.6, 0.8, 0) : new Vec(0, -1, 0);
      await tick(250);
      const t0 = now();
      (c.ctx as any).__noop = 0;
      await tick(250);
      times.push(now() - t0);
      const st2 = c.stats();
      drawnMax = Math.max(drawnMax, st2.drawn);
      res.push(`${label}: ${st2.drawn}/${st2.sheets} listů čarami, ${st2.units} úseků, ${st2.ids} kreseb Gizmos`);
      expect(st2.units).toBeLessThanOrEqual(6000 + 255 * 12);
      expect(c.gizmos.size).toBeLessThanOrEqual(98);
      expect(c.units()).toBeLessThanOrEqual(16384);
    }
    const s2 = c.stats();
    console.log(`klient (režim čar): ${res.join("; ")}; průchod ~${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)} ms (vč. přestavby), plánů ${s2.plans} za ${s2.planMs} ms, Gizmos.set ${s2.setMs} ms, žádostí o data ${s2.requests}`);
    expect(drawnMax).toBeGreaterThan(0); // dřív v režimu textura 0 listů, 0 plánů: test neměřil nic
  });

  it("klient: cizí živé kreslení až do stropu (320 tahů, 13 000 bodů), divák 1,5 m od listu", async () => {
    const c = makeClient(() => {}, { pos: new Vec(0, 0.5, 1.6) });
    c.pose.position = new Vec(0, 0.5, 1.6);
    c.pose.forward = new Vec(0, 1, 0);
    const board = { id: 5, kind: "deska", pos: [0, 2, 1.6], n: [0, -1, 0], w: 1.5, h: 1, cols: 1, rows: 1, rev: 0, slots: [{ live: 7, paper: 0 }] };
    c.deliver(EV.okoli, JSON.stringify({ add: [board], del: [], cfg: { rezim: "textura" } }));
    const d = sketch(320, 9, 47);
    c.deliver(EV.zive, JSON.stringify({ b: 5, slot: 0, s: 7, paper: d.paper, inks: d.inks }));
    // jako server: po 150 ms dávka nových tahů (kreslí se ~2 tahy za 150 ms), klient vykresluje po 250 ms
    let t = 0;
    for (let i = 0; i < d.strokes.length; i += 2) {
      c.deliver(EV.zive, JSON.stringify({ b: 5, slot: 0, s: 7, add: encodeK3({ paper: d.paper, inks: [], strokes: d.strokes.slice(i, i + 2) }) }));
      if (i === 200) c.deliver(EV.zive, JSON.stringify({ b: 5, slot: 0, s: 7, undo: 1 })); // jedno zpět uprostřed
      const t0 = now();
      await tick(150);
      t += now() - t0;
    }
    await tick(1000);
    const st = c.stats();
    console.log(
      `klient živě: ${d.strokes.length} tahů po dvou, ${st.plans} plánů celé kresby + ${st.appends ?? "?"} dokreslení, ` +
        `${c.gizmoCalls.set}× Gizmos.set, ${c.gizmoCalls.remove}× remove, ` +
        `klient celkem ${t.toFixed(0)} ms skutečného času za ${(d.strokes.length / 2) * 0.15} s kreslení; nakonec ${st.units} úseků, ${st.ids} kreseb Gizmos`,
    );
    expect(st.drawn).toBe(1);
    expect(st.units).toBeGreaterThan(1000);
    expect(t).toBeLessThan(1500);
  });

  it("server: textura kresby po kouscích (rastr, převzorkování, mipmapy, BC1), 15 000 bodů", () => {
    const d = sketch(320, 9, 47);
    const k = (2 * 1024) / 768 / 1.5;
    // dřív: rastr po kouscích, zbytek naráz
    const cv0 = runSync(renderSheet(d, k, 4000));
    let t0 = now();
    const tex0 = resample(cv0, 1024, 512);
    const dds0 = writeDds(tex0);
    const tail = ms(t0);
    // teď: všechno po kouscích se stejným rozpočtem práce jako rastr; měří se nejdelší krok generátoru
    const steps = function* () {
      const cv = yield* renderSheet(d, k, 4000);
      const b = new Budget(4000);
      const tex = yield* resampleSteps(cv, 1024, 512, b);
      release(cv.px);
      const dds = yield* writeDdsSteps(tex, 4, b);
      release(tex.px);
      return dds;
    };
    const run = () => {
      const g = steps();
      let max = 0;
      let n = 0;
      const start = now();
      for (;;) {
        const t = now();
        const r = g.next();
        max = Math.max(max, now() - t);
        n++;
        if (r.done) return { dds: r.value, max, n, total: now() - start };
      }
    };
    run(); // zahřátí, zásobník bufferů
    const hits0 = poolStats.hits;
    const r = run();
    t0 = now();
    for (let i = 0; i < 20; i++) encodeBC1(tex0);
    const bc1 = ms(t0) / 20;
    console.log(
      `textura po kouscích: celkem ${r.total.toFixed(0)} ms v ${r.n} krocích, nejdelší krok ${r.max.toFixed(2)} ms ` +
        `(dřív převzorkování + mipmapy + BC1 naráz ${tail} ms); BC1 1024×512 ${bc1.toFixed(1)} ms; zásobník: ${poolStats.hits - hits0} polí znovu použito`,
    );
    expect(r.max).toBeLessThan(15);
    expect(poolStats.hits - hits0).toBeGreaterThanOrEqual(4);
    // stejný výsledek jako naráz (převzorkování po řádcích s float32 mezisoučty se smí lišit o zaokrouhlení)
    expect([...r.dds.files.keys()]).toEqual([...dds0.files.keys()]);
    const a = r.dds.files.get("4")!;
    const b = dds0.files.get("4")!;
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    expect(diff / a.length).toBeLessThan(0.01);
  });

  it("klient: nativní plátno, zpět u plné kresby překreslí jen poslední blok tahů", () => {
    class C {
      static calls = 0;
      kids: C[] = [];
      invoke() {
        C.calls++;
        return true;
      }
      createClip() {
        const c = new C();
        this.kids.push(c);
        return c;
      }
    }
    const d = sketch(320, 9, 47);
    const root = new C() as unknown as NativeClip;
    const painter = new Painter(new Pen(root), d.paper, 1e9);
    const blocks = new StrokeBlocks(root, painter);
    const strokes = d.strokes.slice();
    const dr = { ...d, strokes };
    blocks.sync(dr);
    painter.step();
    const open = C.calls;
    C.calls = 0;
    strokes.pop(); // zpět
    blocks.sync(dr);
    painter.step();
    const undo = C.calls;
    // pro srovnání: dřív se po zpět smazalo a znovu nakreslilo všechno
    C.calls = 0;
    const old = new Painter(new Pen(root), d.paper, 1e9);
    old.reset(drawingOps(dr));
    old.step();
    const before = C.calls;
    console.log(`nativní plátno: otevření ${open} volání (${Math.ceil(open / 1500)} snímků po 1500), zpět ${undo} volání (${blocks.redrawn} tahů), dřív zpět ${before} volání (${Math.ceil(before / 1500)} snímků)`);
    expect(blocks.redrawn).toBeLessThanOrEqual(32);
    expect(undo).toBeLessThan(before / 5);
  });
});
