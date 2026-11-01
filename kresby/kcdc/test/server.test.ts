// Server kreseb nad falešným API KCDC: materiál (recepty, míchání, ředění, krám), limity a ověřování tahů,
// perzistence velkých kreseb, napojení na most (identita, práva, úložiště, nabídky) a sprava (panel), moderace.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeK3, type Stroke } from "../src/shared/codec";
import { EV } from "../src/shared/protocol";
import { makeServer, type FakeServer } from "./fake";

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const ink = (s: FakeServer, p = s.henry) => p.rows.filter((r) => r.name.startsWith("kresby:inkoust"));
const pen = (p: number[], a = 1, size = 8): Stroke => ({ tool: 0, a, b: 0, mix: 0, size, op: 255, p });

async function server(opts: Parameters<typeof makeServer>[0] = {}) {
  const s = makeServer(opts);
  await s.start();
  await tick(0);
  return s;
}

async function board(s: FakeServer, kind = "tabule 3 2 1.5") {
  await s.cmd(s.henry, kind);
  await tick(1100);
  return s.henry.last(EV.okoli)?.add?.[0] ?? s.henry.last(EV.deska);
}

/** Henry začne kreslit na list 0; vrátí CanvasMsg */
async function draw(s: FakeServer, b: any, p = s.henry, slot = 0, paper = "Kreslit: Čistý pergamen") {
  s.client(EV.pouzit, p, { b: b.id, slot });
  await s.pick(p, paper);
  await tick(0);
  return p.last(EV.platno);
}

const send = (s: FakeServer, c: any, seq: number, strokes: Stroke[], p = s.henry) =>
  s.client(EV.tahy, p, { s: c.s, seq, d: encodeK3({ paper: c.paper, inks: [], strokes }) });

describe("materiál", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("správce dá sadu, nesprávce nic; inkousty nesou kapky v datech předmětu", async () => {
    const s = await server();
    await s.cmd(s.hans, "dat Hans sada");
    expect(s.chat.at(-1)).toEqual([2, "Na to nemáš právo."]);
    expect(s.hans.rows).toHaveLength(0);
    await s.cmd(s.henry, "dat Henry sada");
    expect(s.henry.count("kresby:pergamen")).toBe(3);
    expect(s.henry.count("kresby:papir")).toBe(3);
    expect(s.henry.count("kresby:kniha")).toBe(1);
    expect(s.henry.count("loot_gooseFeathers")).toBe(1);
    const inks = ink(s);
    expect(inks).toHaveLength(6);
    expect(inks[0].metadata.custom).toMatchObject({ name: "Duběnkový inkoust", data: { dr: 40, mx: 60, st: 245, f: 0 } });
    expect(inks[0].metadata.custom.description).toContain("Zbývá 40 z 60 kapek");
    expect(s.registered.get("kresby:kresba")).toMatchObject({ usable: true, useLabel: "Prohlédnout", stackable: false, visual: "artefakt_BavorCoatofArmsDrawing" });
  });

  it("kniha: recept, míchání jako barvy, ředění, vylití, čtení v nativní knize", async () => {
    const s = await server();
    await s.cmd(s.henry, "dat Henry kniha");
    for (const [k, n] of [["bsmt_copper", 1], ["special_saltpeter", 1], ["alchemyWater", 2], ["pracharna_emptyPotionBottle", 3]] as const) s.ctx.Inventory.add(s.henry, { item: k, amount: n });
    await s.cmd(s.henry, "dat Henry inkoust mesicek");
    const book = s.henry.rows.find((r) => r.name === "kresby:kniha")!;

    void s.use(s.henry, book);
    await s.pick(s.henry, "Připravit inkoust podle receptu");
    expect(s.options(s.henry).find((o: string) => o.startsWith("Měděná modř"))).toBe("Měděná modř");
    await s.pick(s.henry, "Měděná modř");
    await s.pick(s.henry, "Připravit");
    await tick(0);
    expect(s.henry.count("bsmt_copper")).toBe(0);
    expect(s.henry.count("pracharna_emptyPotionBottle")).toBe(2);
    expect(ink(s).map((r) => r.metadata.custom.name)).toEqual(["Měsíčková žluť", "Měděná modř"]);

    // míchání 1 : 1, 10 kapek -> zelená
    await s.pick(s.henry, "Smíchat dva inkousty");
    await s.pick(s.henry, "Měděná modř");
    await s.pick(s.henry, "Měsíčková žluť");
    await s.pick(s.henry, "Poměr 1 : 1");
    await s.pick(s.henry, "10 kapek směsi");
    await tick(0);
    const mixed = ink(s).find((r) => r.metadata.custom.name.startsWith("Inkoust –"))!;
    const [r, g, b] = mixed.metadata.custom.data.rgb;
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(mixed.metadata.custom.data.dr).toBe(10);
    expect(ink(s).find((x) => x.metadata.custom.name === "Měděná modř")!.metadata.custom.data.dr).toBe(35);
    expect(s.henry.count("pracharna_emptyPotionBottle")).toBe(1);

    // ředění vodou
    await s.pick(s.henry, "Zředit inkoust vodou");
    await s.pick(s.henry, "Inkoust –");
    await tick(0);
    const thin = ink(s).find((x) => x.metadata.custom.name.includes("ředěný"))!;
    expect(thin).toBe(mixed); // stejná lahvička (řádek), jen data
    expect(thin.metadata.custom.data).toMatchObject({ dr: 15 });
    expect(thin.metadata.custom.data.st).toBe(153); // 230 * 10 / 15
    expect(s.henry.count("alchemyWater")).toBe(0); // jedna na recept, jedna na ředění

    // vylít
    await s.pick(s.henry, "Vylít inkoust");
    await s.pick(s.henry, "ředěný");
    await tick(0);
    expect(ink(s)).toHaveLength(2);
    expect(s.henry.count("pracharna_emptyPotionBottle")).toBe(2);

    // číst
    await s.pick(s.henry, "Číst knihu");
    await tick(0);
    const pages = s.henry.last(EV.kniha).pages as string[];
    expect(pages.length).toBeGreaterThan(3);
    expect(pages.join("")).toContain("<heading>Zlatý inkoust</heading>");
  });

  it("herní inkoust z kořisti se převede na lahvičku; krám písaře je obchod hry s inkoustem i listy", async () => {
    const s = await server();
    s.ctx.Inventory.add(s.henry, { item: "loot_oakGallInk", amount: 2 });
    await s.cmd(s.henry, "dat Henry kniha");
    void s.use(s.henry, s.henry.rows.find((r) => r.name === "kresby:kniha")!);
    await tick(0);
    expect(s.henry.count("loot_oakGallInk")).toBe(0);
    expect(ink(s).map((r) => r.metadata.custom.data.dr)).toEqual([30, 30]);

    const k = await board(s, "kram");
    expect(k.kind).toBe("kram");
    s.client(EV.pouzit, s.henry, { b: k.id, slot: 0 });
    await tick(0);
    const v = [...s.vendors.values()][0];
    expect(v.opened).toEqual([1]);
    expect(v.stock.find((r: any) => r.item === "c-kresby:pergamen")).toMatchObject({ price: 3 });
    expect(v.stock.find((r: any) => r.item === "c-kresby:inkoust:dubenka").metadata.custom.data.dr).toBe(40);
    expect(new Set(v.stock.map((r: any) => r.item)).size).toBe(v.stock.length); // každá třída jednou
  });
});

describe("kreslení: ověřování a limity", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("server přijme platné tahy a odmítne cizí nástroj, špatný inkoust, souřadnice mimo list a došlý inkoust", async () => {
    const s = await server();
    await s.cmd(s.henry, "dat Hans pergamen");
    s.ctx.Inventory.add(s.hans, { item: "loot_gooseFeathers", amount: 1 });
    await s.cmd(s.henry, "dat Hans inkoust zlato"); // 15 kapek
    const b = await board(s);
    s.hans.position = { ...s.henry.position, distance: s.henry.position.distance } as any;
    const c = await draw(s, b, s.hans);
    expect(c.tools).toEqual([0, 3]);
    expect(c.inks).toHaveLength(1);
    send(s, c, 1, [
      pen([10, 10, 15, 200, 10, 15]), // ok
      { ...pen([10, 20, 15, 200, 20, 15]), tool: 1 }, // štětec nemá
      pen([10, 30, 15, 200, 30, 15], 2), // inkoust 2 není
      pen([10, 40, 15, 900, 40, 15]), // mimo list
      { tool: 3, a: 0, b: 0, mix: 0, size: 40, op: 255, p: [10, 10, 15, 50, 10, 15] }, // škrabka smí vždy
    ], s.hans);
    let a = s.hans.last(EV.ack);
    expect(a).toMatchObject({ seq: 1, ok: 2, rej: [1, 2, 3] });
    // široký štětcem nemá - brkem velikost 160 (40 px) dlouhé tahy: zlato dojde
    const big = Array.from({ length: 12 }, (_, i) => pen([0, i * 40, 15, 767, i * 40 + 5, 15], 1, 160));
    send(s, c, 2, big, s.hans);
    a = s.hans.last(EV.ack);
    expect(a.ok).toBeGreaterThan(0);
    expect(a.rej.length).toBeGreaterThan(0);
    // zbytek nestačí na další široký tah (jeden stojí ~3,1 kapky)
    expect(a.drops[0]).toBeLessThan(3.1);
    expect(a.drops[0]).toBeGreaterThanOrEqual(0);
  });

  it("neplatný vstup ukončí relaci: díra v pořadí, rozbitá data, záplava zpráv", async () => {
    for (const bad of ["gap", "garbage", "flood"] as const) {
      const s = await server();
      await s.cmd(s.henry, "dat Henry sada");
      const b = await board(s);
      const c = await draw(s, b);
      if (bad === "gap") send(s, c, 3, [pen([1, 1, 15])]);
      if (bad === "garbage") s.client(EV.tahy, s.henry, { s: c.s, seq: 1, d: "k3.////AAAA" });
      if (bad === "flood") for (let i = 1; i <= 45; i++) send(s, c, i, [pen([i, 1, 15])]);
      expect(s.henry.last(EV.zavrit).why).toMatch(bad === "gap" ? /Ztratily/ : bad === "garbage" ? /Neplatná/ : /rychlé/);
      await tick(1100);
      expect(s.hans.last(EV.deska).slots[0]).toBeNull(); // list je zase volný
    }
  });

  it("limit bodů, zpět vrátí kapky, opakovaná dávka se nepočítá dvakrát", async () => {
    const s = await server({ config: { admini: ["Henry"], maxPoints: 50 } });
    await s.cmd(s.henry, "dat Henry sada");
    const b = await board(s);
    const c = await draw(s, b);
    const line = (y: number, n: number) => Array.from({ length: n }, (_, i) => [i * 5, y, 15]).flat();
    send(s, c, 1, [pen(line(10, 30)), pen(line(20, 30))]);
    expect(s.henry.last(EV.ack)).toMatchObject({ ok: 1, rej: [1] });
    const after = s.henry.last(EV.ack).drops[0];
    send(s, c, 1, [pen(line(30, 5))]); // stejné seq: ignorováno
    expect(s.henry.all(EV.ack)).toHaveLength(1);
    s.client(EV.zpet, s.henry, { s: c.s, n: 1 });
    expect(s.henry.last(EV.ack).drops[0]).toBeGreaterThan(after);
    expect(s.henry.last(EV.ack).drops[0]).toBe(c.inks[0].drops);
  });

  it("pauza mezi kresbami, a když inkoust mezitím zmizí, kresba se neuloží a plátno se vrátí s tahy", async () => {
    const s = await server();
    await s.cmd(s.henry, "dat Henry sada");
    const b = await board(s);
    let c = await draw(s, b);
    send(s, c, 1, [pen([10, 10, 15, 300, 300, 15], 1, 40)]);
    // zmizí lahvička inkoustu 1 (dal ji pryč)
    const row = ink(s)[0];
    s.henry.rows.splice(s.henry.rows.indexOf(row), 1);
    void s.client(EV.hotovo, s.henry, { s: c.s, title: "Pokus" });
    await s.pick(s.henry, "Nechat viset bez podpisu");
    await tick(0);
    const resume = s.henry.last(EV.platno);
    expect(resume.resume).toMatch(/^k3\./);
    expect(resume.title).toBe("Pokus");
    expect(s.henry.count("kresby:pergamen")).toBe(3); // nic se nespotřebovalo
    s.henry.rows.push(row);
    void s.client(EV.hotovo, s.henry, { s: c.s, title: "Pokus" });
    await s.pick(s.henry, "Nechat viset bez podpisu");
    await tick(0);
    expect(s.henry.last(EV.zavrit).why).toContain("hotová");
    expect(s.henry.count("kresby:pergamen")).toBe(2);
    // druhá kresba hned: pauza (cooldownMs)
    c = await draw(s, b, s.henry, 1);
    send(s, c, 1, [pen([10, 10, 15, 20, 20, 15])]);
    void s.client(EV.hotovo, s.henry, { s: c.s, title: "" });
    await tick(0);
    expect(s.henry.last(EV.platno).resume).toBeTruthy();
    expect(s.henry.last(EV.info).text).toMatch(/za \d+ s/);
  });

  it("nečinnost, odchod od desky a odpojení uvolní list", async () => {
    const s = await server({ config: { admini: ["Henry"], idleMs: 20000 } });
    await s.cmd(s.henry, "dat Henry sada");
    const b = await board(s);
    await draw(s, b);
    await tick(26000);
    expect(s.henry.last(EV.zavrit).why).toContain("Dlouho");
    await draw(s, b);
    s.henry.position = Object.assign(Object.create(Object.getPrototypeOf(s.henry.position)), { x: 0, y: 40, z: 0 });
    await tick(5100);
    expect(s.henry.last(EV.zavrit).why).toContain("Odešel");
    s.henry.position = Object.assign(Object.create(Object.getPrototypeOf(s.henry.position)), { x: 0, y: 0, z: 0 });
    await draw(s, b);
    await s.fire("playerDisconnect", s.henry);
    expect(s.hans.last(EV.deska).slots[0]).toBeNull();
  });

  it("data kreseb: jen podle otisku, s limitem rychlosti na hráče", async () => {
    const s = await server({ config: { admini: ["Henry"], dataRate: 100, cooldownMs: 0 } });
    await s.cmd(s.henry, "dat Henry sada");
    const b = await board(s);
    const hashes: string[] = [];
    for (const slot of [0, 1]) {
      const c = await draw(s, b, s.henry, slot);
      send(s, c, 1, [pen([10, 10, 15, 300, 300, 10, 500, 100, 15], 1, 40)]);
      void s.client(EV.hotovo, s.henry, { s: c.s, title: "K" + slot });
      await s.pick(s.henry, "Nechat viset (podepsat)");
      await tick(0);
      hashes.push(s.hans.last(EV.deska).slots[slot].h);
    }
    await s.client(EV.chci, s.hans, { h: [...hashes, "nesmysl", "0123456789abcdef"] });
    const got = s.hans.all(EV.data);
    expect(got[0].d).toMatch(/^k3\./);
    expect(got[1]).toMatchObject({ h: hashes[1], d: null, retry: true }); // vyčerpaný limit
    expect(got[2]).toMatchObject({ h: "0123456789abcdef", d: null });
    expect(got).toHaveLength(3); // "nesmysl" se zahodí
  });
});

describe("perzistence, most a správa", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("velká kresba nejde do dat předmětu: úložiště + odkaz, po restartu jde prohlédnout", async () => {
    const s = await server({ config: { admini: ["Henry"], itemDataMax: 60 } });
    await s.cmd(s.henry, "dat Henry sada");
    const b = await board(s);
    const c = await draw(s, b);
    send(s, c, 1, [pen(Array.from({ length: 40 }, (_, i) => [i * 15, 100 + (i % 7) * 9, 15]).flat())]);
    void s.client(EV.hotovo, s.henry, { s: c.s, title: "Velká" });
    await s.pick(s.henry, "Vzít s sebou (podepsat)");
    await tick(2100);
    const item = s.henry.rows.find((r) => r.name === "kresby:kresba")!;
    expect(item.metadata.custom.data.k).toBeUndefined();
    expect(item.metadata.custom.data.s).toBe(true);
    const key = `kresby:kresba/${item.metadata.custom.data.id}`;
    expect(s.storage.has(key)).toBe(true);
    expect(item.metadata.custom.data.u).toBe("nick:henry"); // bez mostu stejné id postavy jako standalone most
    await s.stop();

    const s2 = makeServer({ storage: s.storage });
    await s2.start();
    s2.henry.rows.push(JSON.parse(JSON.stringify(item)));
    await s2.use(s2.henry, s2.henry.rows[0]);
    await tick(0);
    expect(s2.henry.last(EV.prohlizet)).toMatchObject({ title: "Velká", author: "Henry" });
  });

  it("most: identita, práva, úložiště a nabídky jdou přes framework", async () => {
    const kv = new Map<string, any>();
    const menus: any[] = [];
    const notes: any[] = [];
    const most = {
      info: () => ({ contract: 1, version: "1.0.0", adapter: "test", overrides: {} }),
      identity: { getCharacterId: (id: number) => "char:" + id, getName: (id: number) => (id === 1 ? "Jindřich ze Skalice" : null), getPlayerId: () => null },
      perms: { has: async (id: number, perm: string) => (id === 1 && perm === "admin") || (id === 2 && perm === "kresby.moderate") },
      storage: {
        get: (k: string) => (kv.has(k) ? JSON.parse(kv.get(k)) : undefined),
        set: (k: string, v: any) => (k.includes(":") ? (kv.set(k, JSON.stringify(v)), true) : false),
        delete: (k: string) => kv.delete(k),
        keys: (p: string) => [...kv.keys()].filter((k) => k.startsWith(p)).sort(),
      },
      notify: (id: number, text: string, kind: string) => void notes.push([id, text, kind]),
      ui: {
        menu: async (id: number, spec: any) => {
          menus.push([id, spec]);
          return spec.options.find((o: any) => o.enabled !== false && !o.id.startsWith("#"))?.id ?? null;
        },
      },
      inventory: { count: (id: number, item: string) => (item === "loot_gooseFeathers" ? 5 : 0) },
    };
    const s = await server({ most: { api: most }, config: { admini: [] } });
    expect(s.logs.join("\n")).toContain("most 1.0.0 (adaptér test");
    await s.cmd(s.hans, "tabule"); // jen kresby.moderate: stavět nesmí
    expect(s.chat.at(-1)![1]).toBe("Na to nemáš právo.");
    // Henry má jen obecné "admin" mostu: stačí na kresby.admin i moderaci
    await s.cmd(s.henry, "dat Henry pergamen");
    await s.cmd(s.henry, "dat Henry inkoust 1");
    await s.cmd(s.henry, "tabule 2 1 1");
    await tick(2100);
    expect([...kv.keys()].filter((k) => k.startsWith("kresby:deska/"))).toHaveLength(1);
    expect(s.storage.size).toBe(0); // vlastní úložiště z configu se nepoužilo

    const b = s.henry.last(EV.okoli).add[0];
    s.client(EV.pouzit, s.henry, { b: b.id, slot: 0 });
    await tick(0);
    expect(menus[0][1].options[0].text).toContain("Kreslit: Čistý pergamen");
    const c = s.henry.last(EV.platno);
    expect(c.tools).toContain(0); // brky hlásí most.inventory.count
    send(s, c, 1, [pen([10, 10, 15, 100, 100, 15])]);
    void s.client(EV.hotovo, s.henry, { s: c.s, title: "Erb" });
    await tick(0);
    await tick(1100);
    const slot = s.hans.last(EV.deska).slots[0];
    expect(slot).toMatchObject({ t: "Erb", a: "Jindřich ze Skalice" });
    expect(notes.some(([id, t]) => id === 1 && t.includes("visí"))).toBe(true);
  });

  it("sprava: panel se zaregistruje, akce vypíší kresby poblíž, zabaví, vrátí a smažou", async () => {
    const panels: any[] = [];
    const s = await server({ sprava: { registerPanel: (def: any, owner: string) => panels.push([def, owner]) } });
    expect(panels).toHaveLength(1);
    const [def, owner] = panels[0];
    expect(owner).toBe("kresby");
    expect(def).toMatchObject({ id: "kresby", title: "Kresby", perm: "kresby.moderate" });
    expect((s.exportsReg.get("spravaPanels") as () => any[])()[0].id).toBe("kresby");
    const act = (id: string) => def.actions.find((a: any) => a.id === id).handler;

    await act("dat")({ caller: s.henry, params: { player: s.henry, co: "sada" } });
    expect(s.henry.count("kresby:pergamen")).toBe(3);
    expect(await act("postavit")({ caller: s.henry, params: { druh: "deska", sloupce: 2, radky: 1, sirka: 1 } })).toContain("Vývěska");
    await tick(1100);
    const b = s.henry.last(EV.okoli).add[0];
    const c = await draw(s, b);
    send(s, c, 1, [pen([10, 10, 15, 100, 100, 15])]);
    void s.client(EV.hotovo, s.henry, { s: c.s, title: "Hanopis" });
    await s.pick(s.henry, "Nechat viset bez podpisu");
    await tick(0);

    const table = (await act("okoli")({ caller: s.henry, params: { dosah: 60 } })).table;
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({ nazev: "Hanopis", autor: "(nepodepsáno)", stav: "visí" });
    const id = table.rows[0].id;
    expect(await act("skryt")({ caller: s.henry, params: { id } })).toContain("zabavena");
    expect(s.hans.last(EV.deska).slots[0]).toBeNull();
    await s.client(EV.chci, s.hans, { h: [c && s.henry.last(EV.deska).slots[0]?.h].filter(Boolean) });
    expect(await act("obnovit")({ caller: s.henry, params: { id } })).toContain("vrácena");
    expect(s.hans.last(EV.deska).slots[0]).toMatchObject({ t: "Hanopis" });
    expect(await act("smazat")({ caller: s.henry, params: { id } })).toContain("smazána");
    expect(s.hans.last(EV.deska).slots[0]).toBeNull();
    expect((await act("stav")({ caller: s.henry, params: {} })).text).toContain("1 desek");
  });

  it("stojan: dřevěná tabule na sloupku, jeden list, po restartu stojí znovu", async () => {
    const s = await server();
    await s.cmd(s.henry, "stojan");
    expect(s.chat.at(-1)![1]).toMatch(/^Stojan \d+ stojí před tebou/);
    expect(s.props[0].model).toBe("objects/manmade/common_decorations/streets_deco/sign_wall_board_rustic.cgf");
    // model desky má přední stranu na −Y a desku vedle sloupku: otočený o 180° proti líci, pata o 0,71 m stranou
    expect(((s.props[0].rot.z % 360) + 360) % 360).toBeCloseTo(0, 3); // líc k Henrymu (yaw 180) + 180 za přední stranu −Y
    expect(Math.abs(s.props[0].pos.x)).toBeCloseTo(0.711, 2); // pata vedle listu (deska visí vpravo od sloupku)

    await tick(2100);
    const b = s.henry.last(EV.okoli).add[0];
    expect(b).toMatchObject({ kind: "stojan", cols: 1, rows: 1 });
    expect(b.slots).toHaveLength(1);
    expect(b.n[1]).toBeLessThan(-0.9); // lícem k Henrymu (dívá se po +Y)
    await s.stop();
    expect(s.props[0].destroyed).toBe(true);
    const s2 = makeServer({ storage: s.storage });
    await s2.start();
    expect(s2.props).toHaveLength(1);
  });

  it("moderace příkazem a zabavená kresba se neposílá", async () => {
    const s = await server();
    await s.cmd(s.henry, "dat Henry sada");
    const b = await board(s);
    const c = await draw(s, b);
    send(s, c, 1, [pen([10, 10, 15, 100, 100, 15])]);
    void s.client(EV.hotovo, s.henry, { s: c.s, title: "X" });
    await s.pick(s.henry, "Nechat viset (podepsat)");
    await tick(0);
    const h = s.hans.last(EV.deska).slots[0].h;
    await s.cmd(s.henry, "kdo");
    const id = Number(/#(\d+)/.exec(s.chat.at(-1)![1])![1]);
    await s.cmd(s.hans, "skryt " + id);
    expect(s.chat.at(-1)![1]).toBe("Na to nemáš právo.");
    await s.cmd(s.henry, "skryt " + id);
    await s.client(EV.chci, s.hans, { h: [h] });
    expect(s.hans.last(EV.data)).toEqual({ h, d: null });
    s.hans.position.x = 1;
    await s.client(EV.pouzit, s.hans, { b: b.id, slot: 0 });
    expect(s.hans.last(EV.info).text).toContain("zabavila");
    await s.cmd(s.henry, "obnovit " + id);
    await s.client(EV.chci, s.hans, { h: [h] });
    expect(s.hans.last(EV.data).d).toMatch(/^k3\./);
  });
});
