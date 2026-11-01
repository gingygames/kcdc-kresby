// Výkon se stovkami kreseb: 300 kreseb na 50 vývěskách v městě 200 × 200 m, 64 hráčů. Měří server (přepočet okolí,
// posílání dat, úložiště), klienta (LOD, rozpočet Gizmos, čas vykreslení) a kodek. Čísla se vypíšou (README).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countPoints, decode, encodeK2, encodeK3, hashOf } from "../src/shared/codec";
import { faceHeight, normalFromYaw } from "../src/shared/layout";
import { EV } from "../src/shared/protocol";
import { gizmoPlan } from "../src/shared/vector";
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
    const s = makeServer({ storage: st, config: { dataRate: 50 * 1024 * 1024 } });
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
    for (const [label, y, look] of [["u desky (1,5 m)", -88.9, 0], ["na náměstí (8 m)", -82, 0], ["procházka", -70, 1]] as const) {
      c.pose.position = new Vec(-10, y, 1.6);
      c.pose.forward = look ? new Vec(0.6, 0.8, 0) : new Vec(0, -1, 0);
      await tick(250);
      const t0 = now();
      (c.ctx as any).__noop = 0;
      await tick(250);
      times.push(now() - t0);
      const st2 = c.stats();
      res.push(`${label}: ${st2.drawn}/${st2.sheets} listů čarami, ${st2.units} úseků, ${st2.ids} kreseb Gizmos`);
      expect(st2.units).toBeLessThanOrEqual(6000 + 255 * 12);
      expect(c.gizmos.size).toBeLessThanOrEqual(98);
      expect(c.units()).toBeLessThanOrEqual(16384);
    }
    const s2 = c.stats();
    console.log(`klient: ${res.join("; ")}; průchod ~${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)} ms (vč. přestavby), plánů ${s2.plans} za ${s2.planMs} ms, Gizmos.set ${s2.setMs} ms, žádostí o data ${s2.requests}`);
  });
});
