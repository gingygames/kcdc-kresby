// Balíčky textur za běhu (1. 11. 2026): nové kresby do malého horkého balíčku, studené se za běhu nepřenačítají,
// při startu bez hráčů se horké přelijí do studených; po přenačtení zprávy jen deskám, které se změnily; generace
// přenačtení (kresba zapsaná po odeslání restartu počká) a opakování, když resourceStart nepřijde.
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeK3 } from "../src/shared/codec";
import { EV } from "../src/shared/protocol";
import { makeServer } from "./fake";
import { sketch } from "./sketch";

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const data = (seed: number) => encodeK3(sketch(12, seed, 20));

describe("balíčky textur za běhu", { timeout: 90000 }, () => {
  let dir = "";
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    dir = mkdtempSync(join(tmpdir(), "kresby-balicky-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const texDir = (shard: string) => join(dir, shard, "stream/textures/kcdc", shard);
  const textures = (shard: string) => (existsSync(texDir(shard)) ? readdirSync(texDir(shard)).filter((n) => n.endsWith(".dds")) : []);
  /** ve kterém balíčku je textura kresby */
  const where = (id: number) =>
    readdirSync(dir).find((s) => s !== "kresby-obrazy-0" && textures(s).includes(`k${id}.dds`)) ?? null;
  const bytesOf = (shard: string) => readdirSync(texDir(shard)).reduce((n, f) => n + statSync(join(texDir(shard), f)).size, 0);

  // bez klientů (jen server): rychlejší, zprávy klientům se jen zaznamenají
  async function boot() {
    const s = makeServer({ assetsDir: dir });
    await s.start();
    await tick(6000); // balíček 0 (prázdné listy)
    const x = (n: string) => s.exportsReg.get(n) as (...a: any[]) => any;
    return { s, x };
  }
  /** počkat, až hák dostane další přenačtení */
  async function untilReload(s: { reloads: unknown[] }, n = s.reloads.length) {
    for (let i = 0; i < 400 && s.reloads.length <= n; i++) await tick(100);
    expect(s.reloads.length).toBeGreaterThan(n);
  }

  it("nové kresby do horkého balíčku (3 na balíček), smazání studený balíček nepřenačte, start bez hráčů přelije horké do studených", async () => {
    const { s, x } = await boot();
    const b = x("boardCreate")({ owner: "t", pos: [0, 2, 1.6], n: [0, -1, 0], w: 3, cols: 4, rows: 2 });
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(x("boardPut")(b, i, data(i + 1), { owner: "t" }));
      await s.settle();
    }
    expect(ids.slice(0, 3).map(where)).toEqual(["kresby-obrazy-1", "kresby-obrazy-1", "kresby-obrazy-1"]);
    expect(where(ids[3])).toBe("kresby-obrazy-2"); // horký balíček plný: další horký
    await untilReload(s);
    expect(s.reloads.at(-1)).toEqual({ novych: ["kresby-obrazy-1", "kresby-obrazy-2"], zmenenych: [] });
    await tick(2000);
    expect(ids.map((id) => x("drawingReady")(id))).toEqual([true, true, true, true]);
    // přenačtení po nové kresbě stáhne jen horký balíček: 3 kresby ~ 1 MB (dřív až 24 kreseb ~ 8 MB)
    expect(bytesOf("kresby-obrazy-1")).toBeLessThan(1.4 * 1024 * 1024);

    // smazání: soubory pryč, žádné přenačtení
    const n = s.reloads.length;
    expect(x("boardClear")(b, 0, "t")).toBe(true);
    expect(where(ids[0])).toBeNull();
    await tick(40000);
    expect(s.reloads.length).toBe(n);
    // místo v horkém balíčku dostane další nová kresba
    const id5 = x("boardPut")(b, 4, data(9), { owner: "t" });
    await s.settle();
    expect(where(id5)).toBe("kresby-obrazy-1");
    await untilReload(s, n);
    expect(s.reloads.at(-1)).toEqual({ novych: [], zmenenych: ["kresby-obrazy-1"] });
    await tick(2000);
    await s.stop();

    // restart serveru bez hráčů: horké kresby do nového studeného balíčku, horké balíčky zůstanou prázdné
    const w2 = { s: makeServer({ assetsDir: dir, storage: s.storage }) };
    for (const r of s.running) w2.s.running.add(r);
    w2.s.Player.list = [];
    await w2.s.start();
    await tick(10);
    const live = [ids[1], ids[2], ids[3], id5];
    expect(live.map(where)).toEqual(["kresby-obrazy-3", "kresby-obrazy-3", "kresby-obrazy-3", "kresby-obrazy-3"]);
    // přejmenované soubory a stav v úložišti hned spolu (ne až za saveMs: pád mezitím by ukazoval na staré balíčky)
    const of = JSON.parse(s.storage.get("kresby:obrazy")!).of;
    expect(live.map((id) => of[id])).toEqual(["kresby-obrazy-3", "kresby-obrazy-3", "kresby-obrazy-3", "kresby-obrazy-3"]);
    expect(textures("kresby-obrazy-1")).toEqual([]);
    expect(textures("kresby-obrazy-2")).toEqual([]);
    expect(readdirSync(texDir("kresby-obrazy-3")).filter((f) => f.startsWith(`k${id5}.`)).sort()).toEqual([`k${id5}.dds`, `k${id5}.dds.1`, `k${id5}.dds.2`, `k${id5}.dds.3`, `k${id5}.dds.4`]);
    const x2 = (nm: string) => w2.s.exportsReg.get(nm) as (...a: any[]) => any;
    expect(x2("drawingReady")(id5)).toBe(false); // přesunutá kresba čeká na přenačtení nového balíčku
    await untilReload(w2.s, 0);
    expect(w2.s.reloads.at(-1)!.novych).toContain("kresby-obrazy-3");
    await tick(2000);
    expect(live.map((id) => x2("drawingReady")(id))).toEqual([true, true, true, true]);
    expect(w2.s.props.filter((p) => !p.destroyed).map((p) => p.model).sort()).toEqual(live.map((id) => `objects/kcdc/kresby-obrazy-3/k${id}.cgf`).sort());

    // za běhu (hráč připojený) se studený balíček nemění ani po smazání: nová kresba jde do horkého
    w2.s.Player.list = [w2.s.henry];
    const n2 = w2.s.reloads.length;
    x2("boardClear")(b, 1, "t");
    const id6 = x2("boardPut")(b, 5, data(11), { owner: "t" });
    await w2.s.settle();
    expect(where(id6)).toBe("kresby-obrazy-1");
    await untilReload(w2.s, n2);
    expect(w2.s.reloads.at(-1)).toEqual({ novych: [], zmenenych: ["kresby-obrazy-1"] });
  });

  it("po přenačtení dostanou zprávu jen desky, jejichž kresba přestala čekat", async () => {
    const { s, x } = await boot();
    const b1 = x("boardCreate")({ owner: "t", pos: [0, 2, 1.6], n: [0, -1, 0], w: 1.5 });
    const b2 = x("boardCreate")({ owner: "t", pos: [3, 2, 1.6], n: [0, -1, 0], w: 1.5 });
    x("boardPut")(b2, 0, data(3), { owner: "t" });
    await s.settle();
    await untilReload(s);
    await tick(2000);
    const count = (id: number) => s.henry.all(EV.deska).filter((m: any) => m.id === id).length;
    const before = [count(b1), count(b2)];
    const did = x("boardPut")(b1, 0, data(4), { owner: "t" });
    await s.settle();
    expect(count(b1)).toBe(before[0] + 1); // pověšení (čeká na texturu)
    await untilReload(s);
    await tick(2000);
    expect(count(b1)).toBe(before[0] + 2); // textura je u klientů
    expect(s.henry.last(EV.deska)).toMatchObject({ id: b1 });
    expect(s.henry.last(EV.deska).slots[0]).toMatchObject({ d: did, o: "kresby-obrazy-1" });
    expect(count(b2)).toBe(before[1]); // druhá deska se nezměnila: žádná zpráva (dřív všechny desky všem)
  });

  it("kresba zapsaná po odeslání přenačtení čeká na další; když resourceStart nepřijde, přenačtení se zopakuje", async () => {
    const { s, x } = await boot();
    const b = x("boardCreate")({ owner: "t", pos: [0, 2, 1.6], n: [0, -1, 0], w: 3, cols: 3, rows: 1 });
    s.reloadCtl.delayMs = 3000; // restart balíčku trvá 3 s
    const a = x("boardPut")(b, 0, data(5), { owner: "t" });
    await s.settle();
    await untilReload(s);
    // restart je odeslaný, balíček ještě neběží: druhá kresba do téhož horkého balíčku
    const c = x("boardPut")(b, 1, data(6), { owner: "t" });
    await s.settle();
    expect(where(c)).toBe(where(a));
    await tick(3100); // resourceStart
    await tick(1600);
    expect(x("drawingReady")(a)).toBe(true);
    expect(x("drawingReady")(c)).toBe(false); // dřív: příznak smazán, Prop s modelem, který balíček nemá
    expect(s.henry.last(EV.deska).slots[1]).toMatchObject({ d: c, pend: 1 });
    await untilReload(s);
    await tick(5000);
    expect(x("drawingReady")(c)).toBe(true);

    // hák nevede k resourceStart: po minutě se přenačtení pošle znovu
    s.reloadCtl.mute = true;
    s.reloadCtl.delayMs = 50;
    const e = x("boardPut")(b, 2, data(7), { owner: "t" });
    await s.settle();
    await untilReload(s);
    const sentAt = s.reloads.length;
    await tick(30000);
    expect(s.reloads.length).toBe(sentAt); // nic rozepsaného, nic se neposílá
    await tick(40000);
    expect(s.reloads.length).toBe(sentAt + 1);
    expect(s.reloads.at(-1)).toEqual({ novych: [], zmenenych: [where(e)] });
    expect(s.logs.join("\n")).toContain("nespustil");
    s.reloadCtl.mute = false;
    await tick(130000); // další pokus (odstup roste: 2 min)
    await tick(2000);
    expect(x("drawingReady")(e)).toBe(true);
  });
});
