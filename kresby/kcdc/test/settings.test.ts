// Nastavení kreseb v editoru správy (registerSettings): inkousty, materiály, nástroje, výkon, vývěsky, moderace.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeK3 } from "../src/shared/codec";
import { EV } from "../src/shared/protocol";
import { makeServer, type FakeServer } from "./fake";

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
type Def = { id: string; perm: string; schema: any[]; get(): any; set(v: any, ctx: any): any; reset(): any; preview(ctx: any): any };

async function server(opts: Parameters<typeof makeServer>[0] = {}) {
  const s = makeServer(opts);
  await s.start();
  await tick(0);
  const def = (s.exportsReg.get("spravaSettings") as () => Def)();
  return { s, def };
}

const save = (s: FakeServer, def: Def, v: any) => def.set(v, { caller: s.henry, previous: def.get() });

describe("nastavení ve správě", () => {
  let dir = "";
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    dir = mkdtempSync(join(tmpdir(), "kresby-nast-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("definice: id, právo, záložky; správa ji dostane i sama (registerSettings) a /kresby nastaveni otevře editor", async () => {
    const got: any[] = [];
    const opened: any[] = [];
    const { s, def } = await server({ sprava: { registerSettings: (d: any, owner: string) => got.push([d.id, owner]), open: async (pid: number, o: any) => (opened.push([pid, o]), true), registerPanel: () => {} } });
    expect(def).toMatchObject({ id: "kresby", perm: "kresby.admin" });
    expect(def.schema.map((f) => f.key)).toEqual(["inkousty", "materialy", "nastroje", "vykon", "vyvesky", "moderace"]);
    expect(got).toEqual([["kresby", "kresby"]]);
    const v = def.get();
    expect(v.inkousty.recepty[0]).toMatchObject({ id: "dubenka", nazev: "Duběnkový inkoust", barva: "#261e1c", druh: "pruhledny", kapek: 40 });
    expect(v.materialy.papiry.map((p: any) => p.id)).toEqual(["pergamen", "papir"]);
    await s.cmd(s.henry, "nastaveni inkousty.recepty.zlato");
    expect(opened).toEqual([[1, { settings: "kresby", path: "inkousty.recepty.zlato" }]]);
    await s.cmd(s.hans, "nastaveni");
    expect(s.chat.at(-1)).toEqual([2, "Na to nemáš právo."]);
  });

  it("nový inkoust z UI: předmět, krám, recept v knize; uloženo a po restartu platí", async () => {
    const { s, def } = await server();
    const v = def.get();
    v.inkousty.recepty.push({ id: "kobalt", nazev: "Kobaltová modř", barva: "#1d3f9a", druh: "kryci", sytost: 95, kapek: 25, popis: "kobalt v oleji", suroviny: [{ predmet: "alchemyOil", pocet: 2, nazev: "olej" }] });
    v.materialy.obchod.zbozi.push({ druh: "ink", recept: "kobalt", cena: 30 });
    const r = await save(s, def, v);
    expect(String(r)).toContain("Uloženo");
    expect(s.registered.has("kresby:inkoust:kobalt")).toBe(true);
    await s.cmd(s.henry, "dat Henry inkoust kobalt");
    const row = s.henry.rows.find((x) => x.name === "kresby:inkoust:kobalt")!;
    expect(row.metadata.custom).toMatchObject({ name: "Kobaltová modř", data: { rgb: [29, 63, 154], f: 1, dr: 25, st: 242 } });
    await s.cmd(s.henry, "kram");
    await tick(1100);
    s.client(EV.pouzit, s.henry, { b: s.henry.last(EV.okoli).add[0].id, slot: 0 });
    await s.settle();
    const stock = [...s.vendors.values()][0].stock;
    expect(stock.find((x: any) => x.item === "c-kresby:inkoust:kobalt")).toMatchObject({ price: 30 });
    // restart: z úložiště
    await s.stop();
    const s2 = makeServer({ storage: s.storage });
    await s2.start();
    const def2 = (s2.exportsReg.get("spravaSettings") as () => Def)();
    expect(def2.get().inkousty.recepty.at(-1)).toMatchObject({ id: "kobalt", nazev: "Kobaltová modř", druh: "kryci" });
    expect(s2.registered.has("kresby:inkoust:kobalt")).toBe(true);
  });

  it("nový druh listu: předmět, nabídka u desky, prázdný list ve světě (textura)", async () => {
    const { s, def } = await server({ assetsDir: dir });
    const v = def.get();
    v.materialy.papiry.push({ kod: 2, id: "velin", nazev: "Velín", popis: "Jemná telecí kůže.", barva: "#f3ead6", styl: "hladky", cena: 9, vaha: 0.02 });
    await save(s, def, v);
    await s.settle(); // prázdné listy se pečou po kouscích na pozadí
    expect(s.registered.get("kresby:list:velin")).toMatchObject({ name: "Velín", price: 9 });
    expect(readdirSync(join(dir, "kresby-obrazy-0/stream/objects/kcdc/kresby-obrazy-0"))).toContain("list2.cgf");
    await s.cmd(s.henry, "dat Henry velin 2");
    await s.cmd(s.henry, "dat Henry nastroje");
    await s.cmd(s.henry, "dat Henry inkoust 1");
    expect(s.henry.count("kresby:list:velin")).toBe(2);
    await s.cmd(s.henry, "tabule");
    await tick(1100);
    s.client(EV.pouzit, s.henry, { b: s.henry.last(EV.okoli).add[0].id, slot: 0 });
    await s.settle();
    expect(s.options(s.henry)).toContain("Kreslit: Velín (2)");
    await s.pick(s.henry, "Kreslit: Velín");
    const c = s.henry.last(EV.platno);
    expect(c.paper).toBe(2);
    s.client(EV.tahy, s.henry, { s: c.s, seq: 1, d: encodeK3({ paper: 2, inks: [], strokes: [{ tool: 0, a: 1, b: 0, mix: 0, size: 8, op: 255, p: [10, 10, 15, 300, 300, 15] }] }) });
    void s.client(EV.hotovo, s.henry, { s: c.s, title: "Na velínu" });
    await s.pick(s.henry, "Vzít s sebou (podepsat)");
    expect(s.henry.count("kresby:list:velin")).toBe(1);
    expect(s.henry.rows.find((x) => x.name === "kresby:kresba")!.metadata.custom.data.p).toBe(2);
    // klient dostane vzhled papírů
    expect(s.henry.all(EV.okoli).at(-1).cfg.vzhled.papers.map((p: any) => p.kod)).toEqual([0, 1, 2, 31]); // 31 = tabule (SYSTEM_PAPERS)
  });

  it("nástroje a efekty, limity: velikost stopy, vypnutý štětec, tah mimo limit odmítnut", async () => {
    const { s, def } = await server();
    const v = def.get();
    v.nastroje.stetec.zapnuto = false;
    v.nastroje.velikost = { min: 1, max: 10 };
    v.nastroje.brk.kanky = 0;
    await save(s, def, v);
    await s.cmd(s.henry, "dat Henry sada");
    await s.cmd(s.henry, "tabule");
    await tick(1100);
    s.client(EV.pouzit, s.henry, { b: s.henry.last(EV.okoli).add[0].id, slot: 0 });
    await s.pick(s.henry, "Kreslit: Čistý pergamen");
    const c = s.henry.last(EV.platno);
    expect(c.tools).toEqual([0, 2, 3]);
    expect(c.limits).toMatchObject({ sizeMin: 4, sizeMax: 40 });
    s.client(EV.tahy, s.henry, { s: c.s, seq: 1, d: encodeK3({ paper: 0, inks: [], strokes: [{ tool: 0, a: 1, b: 0, mix: 0, size: 8, op: 255, p: [1, 1, 15] }, { tool: 0, a: 1, b: 0, mix: 0, size: 80, op: 255, p: [1, 1, 15] }] }) });
    expect(s.henry.last(EV.ack)).toMatchObject({ ok: 1, rej: [1] });
  });

  it("vývěsky: přesun „vzít moji pozici“, nová deska ze seznamu, smazání", async () => {
    const { s, def } = await server();
    await s.cmd(s.henry, "tabule 3 2 1.5");
    let v = def.get();
    expect(v.vyvesky.seznam).toHaveLength(1);
    const b0 = v.vyvesky.seznam[0];
    expect(b0).toMatchObject({ druh: "deska", sloupce: 3, radky: 2, sirka: 1.5, sklon: 0 });
    expect(b0.pozice.yaw).toBeCloseTo(0); // divák se dívá k +Y (deska hledí k -Y)
    // beze změny: nic se nepřesune
    expect(String(await save(s, def, v))).toBe("Uloženo.");
    // přesun: divák stojí v (10, 20, 0) a dívá se k +X (yaw -90)
    v.vyvesky.seznam[0].pozice = { x: 10, y: 20, z: 0, yaw: -90 };
    v.vyvesky.seznam.push({ id: null, druh: "stojan", pozice: { x: 0, y: 0, z: 0, yaw: 0 }, vzdalenost: 1, vyska: 1.3, sklon: 12, sloupce: 1, radky: 1, sirka: 0.75, vyskaDesky: 0.5 });
    const r = String(await save(s, def, v));
    expect(r).toContain("Deska 1 přesunuta");
    expect(r).toContain("Nová deska");
    v = def.get();
    expect(v.vyvesky.seznam).toHaveLength(2);
    const moved = v.vyvesky.seznam[0];
    expect(moved.pozice.x).toBeCloseTo(10, 2);
    expect(moved.pozice.yaw).toBeCloseTo(-90, 1);
    expect(s.props.some((p) => p.model.includes("sign_wall_board_rustic"))).toBe(true);
    // smazání ze seznamu
    v.vyvesky.seznam = v.vyvesky.seznam.slice(1);
    expect(String(await save(s, def, v))).toContain("Deska 1 smazána");
    expect(def.get().vyvesky.seznam).toHaveLength(1);
  });

  it("moderace: zakázané slovo v názvu, kvóta vystavených; chyby u polí; obnovit výchozí", async () => {
    const { s, def } = await server();
    const v = def.get();
    v.moderace.zakazanaSlova = ["hanba"];
    v.moderace.maxVystavenych = 1;
    v.moderace.cooldownS = 0;
    await save(s, def, v);
    await s.cmd(s.henry, "dat Henry sada");
    await s.cmd(s.henry, "tabule");
    await tick(1100);
    const b = s.henry.last(EV.okoli).add[0];
    const draw = async (slot: number, title: string, pick: string) => {
      s.client(EV.pouzit, s.henry, { b: b.id, slot });
      await s.pick(s.henry, "Kreslit: Čistý pergamen");
      const c = s.henry.last(EV.platno);
      s.client(EV.tahy, s.henry, { s: c.s, seq: 1, d: encodeK3({ paper: 0, inks: [], strokes: [{ tool: 0, a: 1, b: 0, mix: 0, size: 8, op: 255, p: [10, 10, 15, 100, 100, 15] }] }) });
      void s.client(EV.hotovo, s.henry, { s: c.s, title });
      await s.settle();
      if (pick) await s.pick(s.henry, pick);
      return c;
    };
    const c1 = await draw(0, "Velká hanba", "");
    expect(s.henry.last(EV.info).text).toContain("hanba");
    expect(s.henry.last(EV.platno).resume).toBeTruthy();
    s.client(EV.konec, s.henry, { s: c1.s });
    await draw(0, "Hrad", "Nechat viset bez podpisu");
    expect(s.hans.last(EV.deska).slots[0]).toMatchObject({ t: "Hrad" });
    await draw(1, "Druhý", "Nechat viset bez podpisu");
    expect(s.henry.last(EV.info).text).toContain("Vystavených kreseb máš už 1");
    // chyba: dva recepty se stejným id
    const bad = def.get();
    bad.inkousty.recepty.push({ ...bad.inkousty.recepty[0] });
    const r = await save(s, def, bad);
    expect(r).toMatchObject({ ok: false });
    expect(r.errors[0].path).toBe(`inkousty.recepty.${bad.inkousty.recepty.length - 1}.id`);
    // obnovit výchozí
    await def.reset();
    expect(def.get().moderace).toMatchObject({ zakazanaSlova: [], maxVystavenych: 0, cooldownS: 60 });
    expect(s.storage.has("kresby:nastaveni")).toBe(false);
  });
});

describe("schéma proti editoru správy", () => {
  it("checkSchema a validate (sprava/src/settings-core.ts) přijmou schéma i aktuální hodnotu beze změny", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const core = await import("../../../sprava/src/settings-core");
    const s = makeServer();
    await s.start();
    await s.cmd(s.henry, "tabule");
    const def = (s.exportsReg.get("spravaSettings") as () => Def)();
    core.checkSchema(def.schema);
    const value = def.get();
    const r = core.validate(def.schema, value, { itemExists: () => true } as any);
    expect(r.errors).toEqual([]);
    expect(core.diff(value, r.value).map((c: any) => c.path + ": " + JSON.stringify(c.from ?? c.a) + " -> " + JSON.stringify(c.to ?? c.b))).toEqual([]);
    vi.useRealTimers();
  });
});
