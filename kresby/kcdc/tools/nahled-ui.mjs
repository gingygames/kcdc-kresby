// Snímky UI kreseb bez hry: test/snimky.test.ts uloží SVG ze stromu clipů falešného Scaleformu, Edge (headless) je
// převede na PNG do .snimky/. Písma jsou náhradní a pozadí je kreslené dřevo, nejde o snímek ze hry.
//
//   node tools/nahled-ui.mjs [předpona]       (výchozí "po"; snímky .snimky/<předpona>-platno.png …)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const pre = process.argv[2] ?? "po";
const out = resolve(".snimky");
execFileSync(process.execPath, ["tools/build.mjs"], { stdio: "inherit" });
execFileSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "test/snimky.test.ts"], { stdio: "inherit", env: { ...process.env, SNIMKY: out, SNIMKY_PREFIX: pre } });
const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].find(existsSync);
for (const f of readdirSync(out).filter((n) => n.startsWith(pre + "-") && n.endsWith(".svg"))) {
  const svg = join(out, f);
  const png = svg.replace(/\.svg$/, ".png");
  if (!edge) {
    console.log("bez Edge/Chrome zůstává SVG: " + svg);
    continue;
  }
  execFileSync(edge, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--screenshot=${png}`, "--window-size=1920,1080", "file:///" + svg.replace(/\\/g, "/")], { stdio: "ignore" });
  rmSync(svg);
  console.log("snímek: " + png);
}
