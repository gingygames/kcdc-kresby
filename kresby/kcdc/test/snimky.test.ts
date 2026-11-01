// Snímky UI kreseb bez hry: jen když je nastavené SNIMKY=<složka> (spouští tools/nahled-ui.mjs), jinak se přeskočí.
// Plátno s rozkreslenou kresbou a prohlížení z brašny jako SVG ze stromu clipů falešného Scaleformu.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, vi } from "vitest";
import { world, type Clip, type FakeClient } from "./fake";
import { screenSvg } from "./svg";

const OUT = process.env.SNIMKY;
const PRE = process.env.SNIMKY_PREFIX ?? "snimek";
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

async function drag(c: FakeClient, pts: [number, number][]) {
  const scr = c.screens.at(-1)!;
  const sheet = scr.root!.children[0];
  const a = sheet.abs();
  const at = (x: number, y: number) => (scr.mouse = { x: a.x + x * a.sx, y: a.y + y * a.sy });
  at(...pts[0]);
  (c.ctx as any).__press?.(scr) ?? sheet.children[0].handlers.press();
  for (const p of pts.slice(1)) {
    at(...p);
    await tick(16);
  }
  (c.ctx as any).__release?.(scr) ?? sheet.children[0].handlers.release();
  await tick(0);
}
const curve = (f: (t: number) => [number, number], n = 30) => Array.from({ length: n + 1 }, (_, i) => f(i / n));

async function useBoard(c: FakeClient) {
  await tick(250);
  [...c.hints.values()].at(-1)!.handler();
  await tick(0);
}

const shot = (name: string, root: Clip) => {
  mkdirSync(OUT!, { recursive: true });
  writeFileSync(join(OUT!, `${PRE}-${name}.svg`), screenSvg(root));
};

describe.skipIf(!OUT)("snímky UI", () => {
  it("plátno a prohlížení", async () => {
    vi.useFakeTimers();
    const w = world();
    const { s } = w;
    await s.start();
    await s.cmd(s.henry, "dat Henry sada");
    await s.cmd(s.henry, "tabule 3 2 1.5");
    await tick(1100);
    const henry = w.c(s.henry);
    await useBoard(henry);
    await s.pick(s.henry, "Kreslit: Čistý pergamen");
    await tick(500);
    // kopec, hrad, slunce
    await drag(henry, curve((t) => [60 + t * 640, 420 - Math.sin(t * 3.1) * 50]));
    for (const [x0, y0, x1, y1] of [[250, 380, 250, 230], [250, 230, 520, 230], [520, 230, 520, 380], [430, 230, 430, 130], [430, 130, 490, 130], [490, 130, 490, 230]]) {
      await drag(henry, curve((t) => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t], 8));
    }
    await drag(henry, curve((t) => [640 + Math.cos(t * 6.3) * 40, 90 + Math.sin(t * 6.3) * 40], 24));
    await tick(800);
    // klik na zamčený inkoust (šrafovaný vzorek): hláška, kde ho sehnat
    const lockedInk = henry.screens.at(-1)!.root!.all().find((x) => x.handlers.press && x.calls.some((k) => k[0] === "lineStyle" && k[3] === 45));
    lockedInk?.handlers.press();
    await tick(10);
    shot("platno", henry.screens.at(-1)!.root!);

    // dokončit, vzít s sebou, prohlédnout z brašny
    (henry.screens.at(-1)!.root!.find("Hotovo") as Clip).handlers.press();
    await tick(300);
    await s.pick(s.henry, "Vzít s sebou");
    await tick(300);
    const item = s.henry.rows.find((r) => r.name === "kresby:kresba")!;
    await s.use(s.henry, item);
    await tick(1500);
    shot("prohlizeni", henry.screens.at(-1)!.root!);
    if (PRE === "pred") return void vi.useRealTimers();

    // připíchnout na vývěsku a číst na desce, dokud se textura načítá
    henry.screens.at(-1)!.input("kcdc_ui_back");
    await tick(300);
    await useBoard(henry);
    await s.pick(s.henry, "Připíchnout kresbu z brašny");
    await s.pick(s.henry, "Kresba");
    await tick(2100);
    await useBoard(henry);
    await s.pick(s.henry, "Prohlédnout");
    await tick(1500);
    shot("cteni-nacitani", henry.screens.at(-1)!.root!);
    vi.useRealTimers();
  });
});
