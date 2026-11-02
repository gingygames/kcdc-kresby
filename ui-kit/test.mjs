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

test("convertTitle: title -> data-tip, title zmizí; prázdný title se jen odstraní; <title> se nesahá", () => {
  const mk = (tag, attrs) => ({ tagName: tag, attrs: { ...attrs }, hasAttribute(k) { return k in this.attrs; }, getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });
  const b = mk("BUTTON", { title: "Uložit\nzměny" });
  assert.equal(Kit.convertTitle(b), true);
  assert.deepEqual(b.attrs, { "data-tip": "Uložit\nzměny" });
  const e = mk("DIV", { title: "  " });
  assert.equal(Kit.convertTitle(e), true);
  assert.deepEqual(e.attrs, {});
  assert.equal(Kit.convertTitle(mk("SPAN", {})), false);
  const t = mk("TITLE", { title: "x" });
  assert.equal(Kit.convertTitle(t), false);
  assert.equal(t.attrs.title, "x");
  assert.equal(Kit.convertTitle(null), false);
});

test("placeTip: pod kurzorem, u okraje se překlopí, vždy celý na obrazovce", () => {
  assert.deepEqual(Kit.placeTip(100, 100, 200, 40, 1280, 800), { left: 114, top: 120 });
  assert.deepEqual(Kit.placeTip(1200, 100, 200, 40, 1280, 800), { left: 986, top: 120 });
  assert.deepEqual(Kit.placeTip(100, 790, 200, 40, 1280, 800), { left: 114, top: 738 });
  const p = Kit.placeTip(5, 5, 2000, 2000, 1280, 800);
  assert.deepEqual(p, { left: 4, top: 4 });
});

const fakeNode = (tag, attrs) => ({ tagName: tag, attrs: { ...attrs }, hasAttribute(k) { return k in this.attrs; }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; } });

test("convertTitle: prázdný title zruší starý data-tip (title = \"\")", () => {
  const b = fakeNode("BUTTON", { "data-tip": "starý", title: "" });
  assert.equal(Kit.convertTitle(b), true);
  assert.deepEqual(b.attrs, {});
  const c = fakeNode("BUTTON", { "data-tip": "starý", title: "nový" });
  Kit.convertTitle(c);
  assert.deepEqual(c.attrs, { "data-tip": "nový" });
});

test("titleActions: převod, odebrání stránkou zruší tooltip, vlastní odebrání sady se nepočítá", () => {
  const rec = (target, oldValue) => ({ type: "attributes", attributeName: "title", target, oldValue });
  // stránka nastaví title: převést
  const a = fakeNode("DIV", { title: "A" });
  assert.deepEqual(Kit.titleActions([rec(a, null)], new Map()), [{ node: a, act: "convert" }]);
  // sada title odebrala (značka "A"): záznam se spotřebuje, nic se neděje
  const marks = new Map();
  const b = fakeNode("DIV", { "data-tip": "A" });
  marks.set(b, "A");
  assert.deepEqual(Kit.titleActions([rec(b, "A")], marks), [{ node: b, act: null }]);
  assert.equal(marks.has(b), false);
  // stránka title nastavila a hned odebrala (title = "B"; removeAttribute("title")): zrušit data-tip
  const c = fakeNode("DIV", { "data-tip": "A" });
  assert.deepEqual(Kit.titleActions([rec(c, null), rec(c, "B")], new Map()), [{ node: c, act: "drop" }]);
  // po vlastním odebrání sady stránka title znovu nastaví a odebere: poslední změna je stránky -> zrušit
  const d = fakeNode("DIV", { "data-tip": "A" });
  const m2 = new Map([[d, "A"]]);
  assert.deepEqual(Kit.titleActions([rec(d, "A"), rec(d, null), rec(d, "A")], m2), [{ node: d, act: "drop" }]);
  // dvě změny title za sebou (B, pak C): převést, ne zrušit
  const e = fakeNode("DIV", { title: "C" });
  assert.deepEqual(Kit.titleActions([rec(e, null), rec(e, "B")], new Map()), [{ node: e, act: "convert" }]);
  // Kit.select(sel) převedl title synchronně po nastavení stránkou: poslední záznam je sady -> nic
  const f = fakeNode("SELECT", { "data-tip": "A" });
  assert.deepEqual(Kit.titleActions([rec(f, null), rec(f, "A")], new Map([[f, "A"]])), [{ node: f, act: null }]);
  // jiné atributy se ignorují
  assert.deepEqual(Kit.titleActions([{ attributeName: "class", target: a, oldValue: null }], new Map()), []);
});

test("isTabbable: skrytý (nevykreslený) nativní select ani vypnutý prvek se Tabem nepočítá, vlastní tlačítko ano", () => {
  const n = (o) => ({ disabled: false, hidden: false, tabIndex: 0, getClientRects: () => [1], ...o });
  assert.equal(Kit.isTabbable(n({})), true);
  assert.equal(Kit.isTabbable(n({ getClientRects: () => [] })), false);    // display: none (k-select-native)
  assert.equal(Kit.isTabbable(n({ disabled: true })), false);
  assert.equal(Kit.isTabbable(n({ hidden: true })), false);
  assert.equal(Kit.isTabbable(n({ tabIndex: -1 })), false);
  assert.equal(Kit.isTabbable(null), false);
});

test("selectFull: změřená šířka vůči rodiči; v skrytém rodiči (0 px) podle CSS šířky, ne zúžit", () => {
  assert.equal(Kit.selectFull(300, 320, ""), true);
  assert.equal(Kit.selectFull(100, 320, ""), false);
  assert.equal(Kit.selectFull(0, 0, "100%"), true);
  assert.equal(Kit.selectFull(0, 0, "95.5%"), true);
  assert.equal(Kit.selectFull(0, 0, "auto"), false);
  assert.equal(Kit.selectFull(0, 0, "14rem"), false);
  assert.equal(Kit.selectFull(0, 0, undefined), false);
});

test("selectMirror: popisek podle vybrané možnosti, skrytí, vypnutí, třídy a tooltip selectu", () => {
  const opts = [{ text: "podle názvu" }, { text: "podle ceny" }];
  const sel = { options: opts, selectedIndex: 1, disabled: false, hidden: false, style: { display: "", visibility: "" }, className: "k-input k-select-native addfrom", getAttribute: (k) => (k === "data-tip" ? "Řazení" : null) };
  assert.deepEqual(Kit.selectMirror(sel, true), { label: "podle ceny", disabled: false, hidden: false, visibility: "", tip: "Řazení", cls: "k-input addfrom k-select k-select--full" });
  // option.selected = true / form.reset() změní selectedIndex bez události: popisek se čte znovu
  sel.selectedIndex = 0;
  assert.equal(Kit.selectMirror(sel, false).label, "podle názvu");
  sel.hidden = true;
  assert.equal(Kit.selectMirror(sel, false).hidden, true);
  sel.hidden = false; sel.style.display = "none";
  assert.equal(Kit.selectMirror(sel, false).hidden, true);
  sel.style.display = ""; sel.disabled = true; sel.selectedIndex = -1; sel.className = "";
  assert.deepEqual(Kit.selectMirror(sel, false), { label: "", disabled: true, hidden: false, visibility: "", tip: "Řazení", cls: "k-select" });
});

test("selectButtonKey: klávesa, která otevře seznam, nedojde k posluchačům stránky; ostatní projdou", () => {
  const ev = (key) => ({ key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
  for (const key of ["ArrowDown", "ArrowUp", "Enter", " "]) {
    let opened = 0;
    const e = ev(key);
    assert.equal(Kit.selectButtonKey(e, () => opened++), true);
    assert.deepEqual([e.prevented, e.stopped, opened], [true, true, 1], key);
  }
  for (const key of ["q", "Escape", "Tab", "e"]) {
    let opened = 0;
    const e = ev(key);
    assert.equal(Kit.selectButtonKey(e, () => opened++), false);
    assert.deepEqual([e.prevented, e.stopped, opened], [false, false, 0], key);
  }
});
