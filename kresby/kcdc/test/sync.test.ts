// Kresby od začátku do konce: server + tři klienti přes falešnou síť (JSON), sestavený resource dist/kresby.
// Vývěska, nabídka, kreslení myší na nativním plátně (Scaleform), potvrzování dávek, živý přenos divákovi,
// dokončení a spotřeba materiálu, stažení dat na vyžádání, kresba ve světě (Gizmos), restart serveru.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decode, encodeK3 } from "../src/shared/codec";
import { EV } from "../src/shared/protocol";
import { world, type Clip, type FakeClient, type FakeServer } from "./fake";
import { sketch } from "./sketch";

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** postaví vývěsku před Henrym a dá mu materiál */
async function setup(opts: Parameters<typeof world>[0] = {}) {
  const w = world(opts);
  await w.s.start();
  await w.s.cmd(w.s.henry, "dat Henry sada");
  await w.s.cmd(w.s.henry, "tabule 3 2 1.5");
  await tick(1100);
  return w;
}

/** Henry použije desku (nápověda akce v klientu = to, na co se dívá) */
async function useBoard(s: FakeServer, c: FakeClient) {
  await tick(250);
  const hint = [...c.hints.values()].at(-1);
  expect(hint, "nápověda akce u vývěsky").toBeTruthy();
  hint!.handler();
  await tick(0);
}

function canvasOf(c: FakeClient) {
  const scr = c.screens.at(-1)!;
  const root = scr.root!;
  const sheet = root.children[0];
  const paper = sheet.children[0];
  const button = (label: string) => root.find(label) as Clip;
  return { scr, root, sheet, paper, button };
}

/** tah myší po listu: body v logických px listu */
async function drag(c: FakeClient, pts: [number, number][]) {
  const { scr, sheet, paper } = canvasOf(c);
  const a = sheet.abs();
  const at = (x: number, y: number) => (scr.mouse = { x: a.x + x * a.sx, y: a.y + y * a.sy });
  at(...pts[0]);
  paper.handlers.press();
  for (const p of pts.slice(1)) {
    at(...p);
    await tick(16);
  }
  paper.handlers.release();
  await tick(0);
}

const line = (x0: number, y0: number, x1: number, y1: number, n = 30): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);

describe("kreslení od začátku do konce", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("vývěska na povrchu, kam se správce dívá, a jen hráči v dosahu o ní vědí", async () => {
    const { s, c } = await setup();
    const okoli = s.hans.last(EV.okoli);
    expect(okoli.add).toHaveLength(1);
    expect(okoli.add[0]).toMatchObject({ kind: "deska", cols: 3, rows: 2, w: 1.5, n: [0, -1, 0] });
    expect(okoli.add[0].pos[1]).toBeCloseTo(2.99, 2);
    expect(okoli.cfg.platno).toBe("auto");
    expect(s.far.last(EV.okoli)?.add ?? []).toHaveLength(0);
    await tick(2100); // zápisy do úložiště se slučují (saveMs)
    expect([...s.storage.keys()].some((k) => k.startsWith("kresby:deska/"))).toBe(true);
  });

  it("kreslení: nativní plátno, dávky, potvrzení, divák naživo, pověšení, spotřeba, kresba ve světě, restart", async () => {
    const { s, c } = await setup();
    const henry = c(s.henry);
    const hans = c(s.hans);
    const dropsBefore = s.henry.rows.filter((r) => r.name.startsWith("kresby:inkoust")).map((r) => r.metadata.custom.data.dr);
    const sheets = s.henry.count("kresby:pergamen");

    await useBoard(s, henry);
    expect(s.options(s.henry)).toContain(`Kreslit: Čistý pergamen (${sheets})`);
    await s.pick(s.henry, "Kreslit: Čistý pergamen");
    await tick(400);
    const canvas = s.henry.last(EV.platno);
    expect(canvas.tools).toEqual([0, 1, 2, 3]);
    expect(canvas.inks.length).toBeGreaterThanOrEqual(6);
    expect(henry.shots.at(-1)?.position).toBeTruthy(); // kamera na list
    expect(henry.screens).toHaveLength(1);
    expect(henry.screens[0].focused).toBe(true);
    expect(henry.cursor()).toBe(1);

    // dva tahy brkem prvním inkoustem
    await drag(henry, line(100, 100, 600, 120));
    await drag(henry, line(120, 300, 500, 420, 40));
    await tick(300);
    const acks = s.henry.all(EV.ack);
    expect(acks.length).toBeGreaterThanOrEqual(1);
    expect(acks.every((a: any) => a.rej.length === 0)).toBe(true);
    expect(acks.at(-1).drops[0]).toBeLessThan(canvas.inks[0].drops);

    // Hans stojí 4 m vedle: dostává kreslení naživo (ve světě je čistý list a přes něj tahy čarami)
    const live = s.hans.all(EV.zive);
    expect(live[0].inks).toHaveLength(canvas.inks.length);
    const strokes = live.flatMap((m: any) => (m.add ? decode(m.add, 16)!.strokes : []));
    expect(strokes.length).toBe(2);
    await tick(300);
    expect([...hans.gizmos.keys()].some((k) => k.startsWith("k"))).toBe(true); // tahy naživo i v režimu textura
    expect(hans.gizmos.has("papir0")).toBe(false); // papír je Prop, ne Gizmos
    expect(s.props.filter((x) => !x.destroyed).length).toBe(1); // čistý list, na který se kreslí
    expect(s.far.all(EV.zive)).toHaveLength(0);

    // zpět a znovu
    canvasOf(henry).button("Zpět").handlers.press();
    await tick(300);
    expect(s.henry.all(EV.ack).at(-1).drops[0]).toBeGreaterThan(acks.at(-1).drops[0]);
    await drag(henry, line(200, 200, 700, 480, 50));
    await tick(300);

    // hotovo -> dialog -> nechat viset (podepsat)
    canvasOf(henry).button("Hotovo").handlers.press();
    await tick(300);
    expect(henry.screens[0].visible).toBe(false);
    await s.pick(s.henry, "Nechat viset (podepsat)");
    await tick(300);
    expect(s.henry.last(EV.zavrit).why).toContain("hotová");
    expect(henry.screens[0].valid).toBe(false);
    expect(henry.shots.at(-1)).toBeNull(); // kamera zpět
    expect(henry.cursor()).toBe(0);

    // spotřeba: list a kapky prvního inkoustu
    expect(s.henry.count("kresby:pergamen")).toBe(sheets - 1);
    const dropsAfter = s.henry.rows.filter((r) => r.name.startsWith("kresby:inkoust")).map((r) => r.metadata.custom.data.dr);
    expect(dropsAfter[0]).toBeLessThan(dropsBefore[0]);
    expect(dropsAfter.slice(1)).toEqual(dropsBefore.slice(1));
    expect(s.henry.rows.find((r) => r.name.startsWith("kresby:inkoust"))!.metadata.custom.description).toContain(`Zbývá ${dropsAfter[0]} z`);

    // deska: hash ve slotu u všech, kdo o ní vědí; ve světě visí list jako Prop (osvětlený model), žádné čáry
    const desk = s.hans.last(EV.deska);
    const slot = desk.slots.find((x: any) => x?.h);
    expect(slot).toMatchObject({ t: "Kresba", a: "Henry", paper: 0 });
    await tick(600);
    const sheet = s.props.filter((x) => !x.destroyed);
    expect(sheet).toHaveLength(1);
    // bez balíčků textur (test bez fs) je to list hry; s nimi model kresby (test/assets.test.ts)
    expect(sheet[0].model).toContain("paper_a.cgf");
    expect(sheet[0].physics).toBe("none");
    // list leží na líci desky (y ~ 2,99 m, 4 mm před ním), lícem k hráčům (-Y)
    expect(sheet[0].pos.y).toBeCloseTo(2.99 - 0.004, 3);
    expect(sheet[0].scale).toBeCloseTo(0.46, 2);
    expect([...hans.gizmos.keys()].filter((k) => k.startsWith("k"))).toHaveLength(0);
    expect(s.hans.all(EV.data)).toHaveLength(0); // data kreseb se ve světě nestahují (jen ke čtení)

    // restart serveru: stejné úložiště, Hans znovu vidí totéž
    await s.stop();
    const w2 = world({ storage: s.storage });
    await w2.s.start();
    await tick(1100);
    const again = w2.s.hans.last(EV.okoli).add[0].slots.find((x: any) => x?.h);
    expect(again.h).toBe(slot.h);
    await tick(600);
    expect(w2.s.props.filter((x) => !x.destroyed)).toHaveLength(1); // list je po restartu zase ve světě
  });

  it("ladicí režim čar (svet.rezim = cary): kresby jako Gizmos, data na vyžádání", async () => {
    const { s, c } = await setup({ config: { admini: ["Henry"], svet: { rezim: "cary" } } });
    const henry = c(s.henry);
    const hans = c(s.hans);
    await useBoard(s, henry);
    await s.pick(s.henry, "Kreslit: Čistý pergamen");
    await tick(400);
    await drag(henry, line(100, 100, 600, 120));
    await drag(henry, line(120, 300, 500, 420, 40));
    await tick(300);
    expect([...hans.gizmos.keys()].some((k) => k.startsWith("k"))).toBe(true); // naživo
    canvasOf(henry).button("Hotovo").handlers.press();
    await tick(300);
    await s.pick(s.henry, "Nechat viset (podepsat)");
    await tick(900);
    const slot = s.hans.last(EV.deska).slots.find((x: any) => x?.h);
    const data = s.hans.all(EV.data).find((d: any) => d.h === slot.h);
    expect(decode(data.d)!.strokes).toHaveLength(2);
    expect(hans.gizmos.has("papir0")).toBe(true);
    const ink = [...hans.gizmos.entries()].filter(([k]) => k.startsWith("k"));
    expect(ink.length).toBeGreaterThan(0);
    expect(hans.units()).toBeLessThanOrEqual(16384);
    const pt = ink[0][1].prim.points[0];
    expect(pt.y).toBeGreaterThan(2.9);
    expect(pt.y).toBeLessThan(3.0);
    expect(s.props.filter((x) => !x.destroyed)).toHaveLength(0); // žádné listy jako Prop
  });

  it("vzít s sebou: kresba v brašně nese data, jde prohlédnout, připíchnout a strhnout", async () => {
    const { s, c } = await setup();
    const henry = c(s.henry);
    await useBoard(s, henry);
    await s.pick(s.henry, "Kreslit: Arch papíru");
    await tick(400);
    await drag(henry, line(50, 50, 700, 450));
    await tick(300);
    canvasOf(henry).button("Hotovo").handlers.press();
    await tick(300);
    await s.pick(s.henry, "Vzít s sebou bez podpisu");
    await tick(300);
    const item = s.henry.rows.find((r) => r.name === "kresby:kresba")!;
    expect(item.metadata.custom.name).toBe("Kresba");
    expect(item.metadata.custom.description).toContain("Nepodepsáno");
    expect(item.metadata.custom.data.k).toMatch(/^k3\./);
    expect([...s.storage.keys()].filter((k) => k.startsWith("kresby:kresba/"))).toHaveLength(0); // nese ji předmět

    // prohlédnout z brašny: nativní prohlížeč
    await s.use(s.henry, item);
    await tick(800);
    expect(henry.menus).toEqual([["inventory", false], ["inventory", true]]); // inventář se zavře, prohlížeč ho nepřekryje
    expect(s.henry.last(EV.prohlizet)).toMatchObject({ title: "Kresba", author: "", paper: 1 });
    const viewer = henry.screens.at(-1)!;
    expect(viewer.focused).toBe(true);
    expect(viewer.root!.lines()).toBeGreaterThan(20);
    viewer.input("kcdc_ui_accept"); // klávesa, kterou se čtení otevřelo: prohlížeč nezavře
    expect(viewer.valid).toBe(true);
    await tick(600);
    viewer.input("kcdc_ui_back");
    expect(viewer.valid).toBe(false);

    // připíchnout na vývěsku
    await useBoard(s, henry);
    await s.pick(s.henry, "Připíchnout kresbu z brašny");
    await s.pick(s.henry, "Kresba");
    await tick(2100);
    expect(s.henry.rows.find((r) => r.name === "kresby:kresba")).toBeUndefined();
    expect([...s.storage.keys()].filter((k) => k.startsWith("kresby:kresba/"))).toHaveLength(1);
    await tick(300);

    // Hans ji strhne (tearDown "anyone")
    c(s.hans).ray.dir.x = -0.33; // Hans stojí vpravo, musí se podívat k desce
    s.hans.position.x = 1;
    c(s.hans).pose.position.x = 1;
    await useBoard(s, c(s.hans));
    await s.pick(s.hans, "Strhnout list");
    await tick(2100);
    expect(s.hans.rows.find((r) => r.name === "kresby:kresba")?.metadata.custom.data.k).toMatch(/^k3\./);
    expect([...s.storage.keys()].filter((k) => k.startsWith("kresby:kresba/"))).toHaveLength(0);
  });

  it("bez Scaleformu (nebo bez myši) se plátno otevře v HTML", async () => {
    const { s, c } = await setup({ clients: { mouse: false } });
    const henry = c(s.henry);
    await useBoard(s, henry);
    await s.pick(s.henry, "Kreslit: Čistý pergamen");
    await tick(500);
    expect(henry.views).toHaveLength(1);
    const v = henry.views[0];
    expect(v.url).toBe("fw://resources/kresby/ui/platno.html");
    expect(v.shown && v.focused).toBe(true);
    expect(v.emitted[0][0]).toBe("kresby:canvas");
    // stránka pošle tah
    v.handlers.get("kresby:stroke")!({ p: [10, 10, 15, 300, 200, 12, 600, 400, 10], brush: { tool: 0, a: 2, b: 0, mix: 0, size: 8, op: 255 } });
    await tick(300);
    expect(s.henry.all(EV.ack).at(-1)).toMatchObject({ ok: 1, rej: [] });
    expect(v.emitted.some(([n]) => n === "kresby:result")).toBe(true);
    v.handlers.get("kresby:cancel")!(null);
    await tick(10);
    expect(s.henry.last(EV.zavrit).why).toContain("čistý");
    expect(v.shown).toBe(false);
  });

  it("vlastní UI frameworku přes setUi (háček plátna)", async () => {
    const { s, c } = await setup();
    const henry = c(s.henry);
    const opened: any[] = [];
    (henry.exportsReg.get("setUi") as any)({
      canvas: {
        open: (api: any) => (opened.push(api), true),
        close: () => opened.push("close"),
      },
    });
    await useBoard(s, henry);
    await s.pick(s.henry, "Kreslit: Čistý pergamen");
    await tick(300);
    expect(henry.screens).toHaveLength(0);
    const api = opened[0];
    expect(api.addStroke([0, 0, 15, 100, 100, 15])).toBeNull();
    api.finish("Můj erb");
    await tick(300);
    await s.pick(s.henry, "Nechat viset bez podpisu");
    await tick(300);
    expect(s.hans.last(EV.deska).slots.find((x: any) => x?.h)).toMatchObject({ t: "Můj erb" });
    expect(opened.at(-1)).toBe("close");
  });

  it("divák naživo: konec relace a hned nová se stejným číslem - list se překreslí (podpis se neopakuje)", async () => {
    const { s, c } = await setup();
    const henry = c(s.henry);
    const hans = c(s.hans);
    await useBoard(s, henry);
    await s.pick(s.henry, "Kreslit: Čistý pergamen");
    await tick(400);
    await drag(henry, line(100, 100, 600, 120));
    await drag(henry, line(120, 300, 500, 420, 40));
    await tick(600);
    const first = s.hans.all(EV.zive)[0];
    const ink = () => JSON.stringify([...hans.gizmos.entries()].filter(([k]) => k.startsWith("k")).map(([, g]) => g.prim));
    const before = ink();
    expect(before).not.toBe("[]");
    // relace skončí a hned (bez snímku mezi tím) začne nová se stejným číslem a stejným počtem jiných tahů
    const other = sketch(2, 7, 20);
    hans.deliver(EV.zive, { b: first.b, slot: first.slot, s: first.s, end: true });
    hans.deliver(EV.zive, { b: first.b, slot: first.slot, s: first.s, paper: 0, inks: first.inks, add: encodeK3({ ...other, inks: first.inks, paper: 0 }) });
    await tick(600);
    expect(ink()).not.toBe(before); // dřív reset znovu od 1: stejný podpis, zůstaly staré (i vzaté) tahy
  });

  it("plátno: zpět a znovu, zamčené inkousty s radou, stav ukládání, měřená latence", async () => {
    const { s, c } = await setup();
    const henry = c(s.henry);
    await useBoard(s, henry);
    await s.pick(s.henry, "Kreslit: Čistý pergamen");
    await tick(400);
    const cv = s.henry.last(EV.platno);
    expect(cv.locked.length).toBeGreaterThan(0);
    expect(cv.locked[0].where).toMatch(/písař|Namíchej/i);
    await drag(henry, line(100, 100, 600, 120));
    expect(canvasOf(henry).root.all().some((x) => /Ukládám 1 tah/.test(x.text))).toBe(true);
    await tick(300);
    expect(canvasOf(henry).root.all().some((x) => x.text === "✓ Vše uloženo")).toBe(true);
    canvasOf(henry).button("Zpět").handlers.press();
    await tick(300);
    canvasOf(henry).button("Znovu").handlers.press();
    await tick(300);
    const acks = s.henry.all(EV.ack);
    expect(acks.at(-1).rej).toEqual([]);
    expect(acks.at(-1).drops[0]).toBeLessThan(cv.inks[0].drops); // tah je zpátky (spotřeba)
    canvasOf(henry).button("Zahodit").handlers.press();
    await tick(200);
    canvasOf(henry).button("Zahodit").handlers.press();
    await tick(300);
    const lat = henry.logs.find((l) => l.includes("vzorek -> čára"));
    expect(lat).toBeTruthy();
    console.log(lat);
  });
});
