// API kreseb pro jiné resources (server/api.ts): desky s vlastníkem, volné kreslení s předlohou, vložená kresba.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decode, encodeK3, type Stroke } from "../src/shared/codec";
import { EV } from "../src/shared/protocol";
import { Vec, makeServer } from "./fake";

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const pen = (p: number[], a = 1): Stroke => ({ tool: 0, a, b: 0, mix: 0, size: 8, op: 255, p });
const CHALK = { rgb: [236, 232, 220] as [number, number, number], flags: 1, strength: 255 };

async function server() {
  const s = makeServer();
  await s.start();
  await tick(0);
  const x = (name: string) => s.exportsReg.get(name) as (...a: any[]) => any;
  return { ...s, x };
}

describe("API pro jiné resources", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("tabule školy: kreslení bez materiálu na předlohu, zpět ji nevezme, hotovo nahradí list a zavolá done", async () => {
    const s = await server();
    expect(s.x("paperCode")("tabule")).toBe(31);
    const id = s.x("boardCreate")({ owner: "skola", pos: [0, 2, 1.6], n: [0, -1, 0], w: 2, cols: 1, rows: 1 });
    expect(typeof id).toBe("number");
    expect(s.x("boardCreate")({ pos: [0, 0, 0], n: [0, 1, 0], w: 1 })).toContain("owner");

    // skript napíše na tabuli text (předloha)
    const text = encodeK3({ paper: 31, inks: [CHALK], strokes: [pen([10, 10, 8, 50, 50, 8])] });
    const put = s.x("boardPut")(id, 0, text, { owner: "skola", title: "A" });
    expect(typeof put).toBe("number");
    expect((await s.x("boardGet")(id, 0)).d).toBe(text);

    // hráč bez jediného listu a inkoustu dostane křídu a kreslí dál na to, co na tabuli je
    const done: any[] = [];
    const r = await s.x("boardDraw")(2, id, 0, { owner: "skola", paper: 31, inks: [CHALK], tools: [0, 1], base: text, title: "Tabule", done: (x: any) => done.push(x) });
    expect(r).toBe(true);
    const c = s.hans.last(EV.platno);
    expect(c).toMatchObject({ paper: 31, tools: [0, 1], unlimited: true, locked: [] }); // plátno bez kapek a bez zamčených receptů
    expect(decode(c.resume, 16)!.strokes).toHaveLength(1);
    expect(s.x("boardInfo")(id).live[0]).toBeGreaterThan(0);

    await s.client(EV.tahy, s.hans, { s: c.s, seq: 1, d: encodeK3({ paper: 31, inks: [], strokes: [pen([100, 100, 8, 200, 120, 8])] }) });
    expect(s.hans.last(EV.ack)).toMatchObject({ ok: 1, rej: [] });
    // zpět o 3: vezme jen nový tah, předlohu klient dostane zpátky
    await s.client(EV.zpet, s.hans, { s: c.s, n: 3 });
    expect(decode(s.hans.last(EV.platno).resume, 16)!.strokes).toHaveLength(1);
    await s.client(EV.tahy, s.hans, { s: c.s, seq: 2, d: encodeK3({ paper: 31, inks: [], strokes: [pen([300, 300, 8, 310, 330, 8])] }) });
    await s.client(EV.hotovo, s.hans, { s: c.s, title: "" });
    await tick(0);

    expect(s.dialog(s.hans)).toBeUndefined(); // žádný dialog nechat viset / vzít
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ ok: true, player: 2, board: id, slot: 0, added: 1 });
    expect(decode(done[0].d)!.strokes).toHaveLength(2);
    const now = await s.x("boardGet")(id, 0);
    expect(now.id).toBe(done[0].id);
    expect(now.t).toBe("Tabule");
    expect(s.storage.has("kresby:kresba/" + put)).toBe(false); // stará kresba tabule smazaná
    expect(s.hans.rows).toHaveLength(0); // nic se nedalo ani nevzalo
  });

  it("deska s vlastníkem: nabídka kreseb ji ignoruje, cizí vlastník nic nesmaže, přerušení zavolá done ok:false", async () => {
    const s = await server();
    const id = s.x("boardCreate")({ owner: "skola", pos: [0, 2, 1.6], n: [0, -1, 0], w: 1 });
    await s.client(EV.pouzit, s.henry, { b: id, slot: 0 });
    expect(s.dialog(s.henry)).toBeUndefined();
    expect(s.x("boardRemove")(id, "jiny")).toBe(false);
    expect(s.x("boardClear")(id, 0, "skola")).toBe(false); // prázdný list

    const done: any[] = [];
    expect(await s.x("boardDraw")(1, id, 0, { owner: "jiny", inks: [] })).toContain("Deska není");
    expect(await s.x("boardDraw")(1, id, 0, { owner: "skola", inks: [CHALK], done: (x: any) => done.push(x) })).toBe(true);
    expect(await s.x("boardDraw")(2, id, 0, { owner: "skola", inks: [CHALK] })).toContain("jiný");
    const c = s.henry.last(EV.platno);
    await s.client(EV.konec, s.henry, { s: c.s });
    expect(done).toEqual([expect.objectContaining({ ok: false, player: 1, board: id })]);
    expect(s.x("boardRemove")(id, "skola")).toBe(true);
    expect(s.x("boardInfo")(id)).toBeNull();
  });
});

describe("plátno volné relace", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("jména inkoustů od volajícího, inkoust předlohy (pick:false) na plátně nejde vybrat a server tah jím odmítne", async () => {
    const s = await server();
    const id = s.x("boardCreate")({ owner: "skola", pos: [0, 2, 0.8], n: [0, 0, 1], w: 0.3 });
    const r = await s.x("boardDraw")(1, id, 0, { owner: "skola", inks: [{ rgb: [38, 30, 28], flags: 0, strength: 245, name: "Duběnkový inkoust" }, { rgb: [150, 138, 118], flags: 0, strength: 150, name: "Předloha", pick: false }] });
    expect(r).toBe(true);
    const c = s.henry.last(EV.platno);
    expect(c.inks[0]).toMatchObject({ name: "Duběnkový inkoust" });
    expect(c.inks[0].pick).toBeUndefined();
    expect(c.inks[1]).toMatchObject({ name: "Předloha", pick: false, drops: 0 });
    await s.client(EV.tahy, s.henry, { s: c.s, seq: 1, d: encodeK3({ paper: 0, inks: [], strokes: [pen([10, 10, 8, 60, 60, 8], 1), pen([10, 10, 8, 60, 60, 8], 2)] }) });
    expect(s.henry.last(EV.ack)).toMatchObject({ ok: 1, rej: [1] });
  });
});

describe("sdílené kresby", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("jedna připravená kresba visí na víc deskách, s listem se nemaže, drawingDelete ji sundá všude", async () => {
    const s = await server();
    const a = s.x("boardCreate")({ owner: "skola", pos: [0, 2, 0.8], n: [0, 0, 1], w: 0.3 });
    const b = s.x("boardCreate")({ owner: "skola", pos: [1, 2, 0.8], n: [0, 0, 1], w: 0.3 });
    const data = encodeK3({ paper: 0, inks: [CHALK], strokes: [pen([10, 10, 8, 50, 50, 8])] });
    expect(s.x("drawingPrepare")("", data)).toContain("owner");
    const id = s.x("drawingPrepare")("skola", data, { title: "Čítanka" });
    expect(typeof id).toBe("number");
    expect(await s.x("boardShow")(a, 0, id, "skola")).toBe(true);
    expect(await s.x("boardShow")(b, 0, id, "skola")).toBe(true);
    expect(await s.x("boardShow")(b, 0, id, "jiny")).toContain("Deska není");
    expect(s.x("boardInfo")(a).slots[0].d).toBe(id);
    expect(s.x("boardInfo")(b).slots[0].d).toBe(id);
    // přepsat list a vymazat list: sdílená kresba zůstane (druhá deska ji pořád ukazuje)
    s.x("boardPut")(a, 0, encodeK3({ paper: 0, inks: [CHALK], strokes: [pen([1, 1, 8, 5, 5, 8])] }), { owner: "skola" });
    expect(s.x("boardClear")(b, 0, "skola")).toBe(true);
    await tick(10000);
    expect(s.storage.has("kresby:kresba/" + id)).toBe(true);
    expect(await s.x("boardShow")(b, 0, id, "skola")).toBe(true);
    // výslovné smazání: pryč z desek i z úložiště; cizí vlastník nesmí
    expect(await s.x("drawingDelete")(id, "jiny")).toBe(false);
    expect(await s.x("drawingDelete")(id, "skola")).toBe(true);
    expect(s.x("boardInfo")(b).slots[0]).toBeNull();
    await tick(10000);
    expect(s.storage.has("kresby:kresba/" + id)).toBe(false);
    // běžná kresba skriptu se s přepsáním listu smaže
    const p1 = s.x("boardPut")(a, 0, data, { owner: "skola" });
    s.x("boardPut")(a, 0, data, { owner: "skola" });
    await tick(10000);
    expect(s.storage.has("kresby:kresba/" + p1)).toBe(false);
    // klientům: deska školy má příznak own (nápověda akce kreseb se u ní neukazuje)
    await tick(1100);
    expect(s.henry.all(EV.okoli).flatMap((m: any) => m.add).find((x: any) => x.id === a)).toMatchObject({ own: 1 });
  });
});

describe("stejný obsah na víc deskách", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("přepsání jedné desky nerozbije načítání stejné kresby (podle otisku) na druhé; školní desky nejsou v nastavení", async () => {
    const s = await server();
    const a = s.x("boardCreate")({ owner: "skola", pos: [0, 2, 0.8], n: [0, 0, 1], w: 0.3 });
    const b = s.x("boardCreate")({ owner: "skola", pos: [1, 2, 0.8], n: [0, 0, 1], w: 0.3 });
    const data = encodeK3({ paper: 0, inks: [CHALK], strokes: [pen([10, 10, 8, 50, 50, 8])] });
    s.x("boardPut")(a, 0, data, { owner: "skola" });
    s.x("boardPut")(b, 0, data, { owner: "skola" });
    s.x("boardPut")(a, 0, encodeK3({ paper: 0, inks: [CHALK], strokes: [pen([1, 1, 8, 9, 9, 8])] }), { owner: "skola" });
    const h = (await s.x("boardGet")(b, 0)).d === data ? s.x("boardInfo")(b) : null;
    expect(h).not.toBeNull();
    // klient si kresbu desky b řekne otiskem
    const { hashOf } = await import("../src/shared/codec");
    await s.client(EV.chci, s.henry, { h: [hashOf(data)] });
    expect(s.henry.last(EV.data)).toMatchObject({ d: data });
    // F10 kreseb školní desky neukazuje (nejde je tam smazat ani přesunout)
    const v = (s.exportsReg.get("spravaSettings") as any)().get();
    expect(v.vyvesky.seznam.some((x: any) => x.id === a || x.id === b)).toBe(false);
  });
});

describe("popisky kreseb a škola", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("název a podpis kresby jdou přes filtr čitelnosti školy, bez školy beze změny", async () => {
    const s = await server();
    await s.cmd(s.henry, "dat Henry sada");
    await s.cmd(s.henry, "tabule 1 1 1");
    await tick(1100);
    const b = s.henry.last(EV.okoli).add[0];
    s.client(EV.pouzit, s.henry, { b: b.id, slot: 0 });
    await s.pick(s.henry, "Kreslit: Čistý pergamen");
    const c = s.henry.last(EV.platno);
    await s.client(EV.tahy, s.henry, { s: c.s, seq: 1, d: encodeK3({ paper: c.paper, inks: [], strokes: [pen([10, 10, 8, 60, 60, 8])] }) });
    await s.client(EV.hotovo, s.henry, { s: c.s, title: "Ema mele" });
    await s.pick(s.henry, "Nechat viset (podepsat)");
    // škola: Hans nečte (pseudoznaky), Henry ano
    s.x("setCaptionFilter")((pid: number, t: string) => (pid === 2 ? t.replace(/\p{L}/gu, "x") : t), "skola");
    s.hans.position = new Vec(0.5, 1, 0);
    s.client(EV.pouzit, s.hans, { b: b.id, slot: 0 });
    await s.settle();
    expect(JSON.stringify(s.dialog(s.hans)!.page)).toContain("„xxx xxxx“");
    await s.pick(s.hans, "Prohlédnout");
    expect(s.hans.last(EV.prohlizet)).toMatchObject({ title: "xxx xxxx", author: expect.stringMatching(/^x+$/) });
    await s.fire("resourceStop", "skola"); // škola skončila: filtr pryč
    s.client(EV.pouzit, s.hans, { b: b.id, slot: 0 });
    await s.pick(s.hans, "Prohlédnout");
    expect(s.hans.last(EV.prohlizet).title).toBe("Ema mele");
  });
});
