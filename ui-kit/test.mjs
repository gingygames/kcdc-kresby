// Testy sady bez závislostí: `node --test ui-kit/test.mjs`
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { contrast, failures, tokens } from "./check.mjs";
import { copyKit, KIT_FILES } from "./copy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const Kit = createRequire(import.meta.url)("./kit.js");

test("kontrasty: všechny dvojice barev vyhovují", () => assert.deepEqual(failures(), []));

test("kontrast: známé hodnoty", () => {
  assert.equal(contrast("#000000", "#ffffff").toFixed(1), "21.0");
  assert.equal(contrast("#777777", "#777777").toFixed(1), "1.0");
  assert.ok(Object.keys(tokens()).length > 25);
});

test("měřítko písma podle výšky okna", () => {
  assert.equal(Kit.scaleFor(1080), 1);
  assert.equal(Kit.scaleFor(720), 0.9);          // dolní mez
  assert.equal(Kit.scaleFor(1440), 1.33);
  assert.equal(Kit.scaleFor(2160), 1.8);
  assert.equal(Kit.scaleFor(9999), 1.8);
  assert.equal(Kit.scaleFor(undefined), 1);
});

test("store: ukládá JSON, vrací výchozí, odděluje jména a přežije nefunkční úložiště", () => {
  const data = new Map();
  const backend = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  const a = Kit.store("a", backend);
  const b = Kit.store("b", backend);
  assert.equal(a.get("x", 7), 7);
  a.set("x", { n: [1, 2] });
  assert.deepEqual(a.get("x"), { n: [1, 2] });
  assert.equal(b.get("x", "nic"), "nic");
  a.del("x");
  assert.equal(a.get("x", 1), 1);
  data.set("kit:a:zle", "{nesmysl");
  assert.equal(a.get("zle", "ok"), "ok");
  const broken = Kit.store("c", { getItem() { throw new Error("zakázáno"); }, setItem() { throw new Error("zakázáno"); }, removeItem() {} });
  broken.set("k", 5);
  assert.equal(broken.get("k"), 5);              // drží se v paměti
});

test("nearest: „myslel jsi …?“", () => {
  const names = ["status", "players", "resources", "restart", "ensure", "log"];
  assert.equal(Kit.nearest("staus", names), "status");
  assert.equal(Kit.nearest("plyers", names), "players");
  assert.equal(Kit.nearest("rest", names), "restart");
  assert.equal(Kit.nearest("Ensur", names), "ensure");
  assert.equal(Kit.nearest("zzzzzz", names), null);
  assert.equal(Kit.nearest("", names), null);
  assert.equal(Kit.nearest("x", []), null);
  assert.equal(Kit.distance("kitten", "sitting"), 3);
});

test("copyKit: zkopíruje soubory sady; js:false vynechá skript", () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-"));
  assert.deepEqual(copyKit(join(dir, "a")), KIT_FILES);
  assert.deepEqual(readdirSync(join(dir, "a")).sort(), [...KIT_FILES].sort());
  assert.deepEqual(copyKit(join(dir, "b"), { js: false }), ["theme.css", "components.css"]);
  assert.equal(readFileSync(join(dir, "a", "theme.css"), "utf8"), readFileSync(join(here, "theme.css"), "utf8"));
});

test("components.css: jen třídy s předponou k- (nesahá na holé elementy stránky)", () => {
  const css = readFileSync(join(here, "components.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, "");
  const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2].trim()).filter(Boolean);
  for (const group of selectors) for (const sel of group.split(",").map((s) => s.trim())) assert.match(sel, /^(body|html)?\.k-/, "selektor „" + sel + "“ nezačíná .k-");
});

test("clampRect: okno nikdy mimo obrazovku ani pod minimem", () => {
  const min = { w: 400, h: 300 };
  assert.deepEqual(Kit.clampRect({ x: -50, y: -50, w: 800, h: 600 }, 1280, 800, min), { x: 0, y: 0, w: 800, h: 600 });
  assert.deepEqual(Kit.clampRect({ x: 1200, y: 700, w: 800, h: 600 }, 1280, 800, min), { x: 480, y: 200, w: 800, h: 600 });
  assert.deepEqual(Kit.clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, 1280, 800, min), { x: 0, y: 0, w: 1280, h: 800 });
  assert.deepEqual(Kit.clampRect({ x: 0, y: 0, w: 10, h: 10 }, 1280, 800, min), { x: 0, y: 0, w: 400, h: 300 });
  assert.deepEqual(Kit.clampRect(null, 1280, 800, min), { x: 0, y: 0, w: 400, h: 300 });
});

test("dragRect: posun, změna velikosti okrajem a rohem, minimum a hranice obrazovky", () => {
  const min = { w: 400, h: 300 };
  const s = { x: 100, y: 100, w: 800, h: 500 };
  assert.deepEqual(Kit.dragRect(s, "move", 50, -500, 1280, 800, min), { x: 150, y: 0, w: 800, h: 500 });
  assert.deepEqual(Kit.dragRect(s, "se", 100, 50, 1280, 800, min), { x: 100, y: 100, w: 900, h: 550 });
  assert.deepEqual(Kit.dragRect(s, "w", -60, 0, 1280, 800, min), { x: 40, y: 100, w: 860, h: 500 });
  assert.deepEqual(Kit.dragRect(s, "w", 700, 0, 1280, 800, min), { x: 500, y: 100, w: 400, h: 500 });   // minimum: pravý okraj zůstane
  assert.deepEqual(Kit.dragRect(s, "n", 0, 900, 1280, 800, min), { x: 100, y: 300, w: 800, h: 300 });
  assert.deepEqual(Kit.dragRect(s, "e", 9999, 0, 1280, 800, min), { x: 100, y: 100, w: 1180, h: 500 });
  assert.deepEqual(Kit.dragRect(s, "nw", -500, -500, 1280, 800, min), { x: 0, y: 0, w: 900, h: 600 });
});
