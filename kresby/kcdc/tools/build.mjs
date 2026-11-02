// Sestaví resource "kresby" pro Kingdoms Connected do dist/kresby/:
//   server.js, client.js        (esbuild, iife, ES2022 - jako loutna a kostra)
//   ui/platno.html, platno.js   záložní HTML plátno (CEF), jen když nativní Scaleform nejde
//   package.json                manifest (mafiahub: serverScripts, clientScripts, files, exports)
//   kresby_config.js            nastavení (založí se z config/kresby_config.example.js, pak se nepřepisuje)
//
//   node tools/build.mjs [--out <složka resources/kresby na serveru KCDC>]
import { copyKit } from "../../../ui-kit/copy.mjs";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist", "kresby");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const types = JSON.parse(readFileSync(join(root, "node_modules", "@kingdomsconnected", "types", "package.json"), "utf8")).version;
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const node = (bin, ...args) => execFileSync(process.execPath, [join(root, "node_modules", ...bin), ...args], { stdio: "inherit" });

// 1. typy (server, klient a stránka jsou tři programy, každý se svými globály)
for (const t of ["server", "client", "web"]) node(["typescript", "bin", "tsc"], "-p", join(root, `tsconfig.${t}.json`));

// 2. bundly
mkdirSync(join(dist, "ui"), { recursive: true });
const bundle = (entry, out, platform = "neutral") =>
  node(["esbuild", "bin", "esbuild"], join(root, entry), "--bundle", "--format=iife", `--platform=${platform}`, "--target=es2022",
    "--charset=utf8", `--outfile=${join(dist, out)}`, "--log-level=warning");
bundle("src/server/main.ts", "server.js");
bundle("src/client/main.ts", "client.js");
bundle("src/web/platno.ts", "ui/platno.js", "browser");
copyFileSync(join(root, "ui", "platno.html"), join(dist, "ui", "platno.html"));
copyKit(join(dist, "ui", "kit")); // sdílený vzhled web view (ui-kit/README.md)

// 3. manifest (docs.kingdomsconnected.com: Resource manifest and lifecycle)
const manifest = {
  name: "kresby",
  version: pkg.version,
  description: `Hráčské kresby: vývěsky a stojany, inkousty, míchání barev, kresby v brašně. API Kingdoms Connected ${types}.`,
  mafiahub: {
    serverScripts: ["kresby_config.js", "server.js"],
    clientScripts: ["client.js"],
    files: ["ui/**"],
    // Bez závislostí. Most tu není: KCDC restartuje se závislostí i všechny, které na ní (i nepovinně) závisejí,
    // a restart mostu by restartoval i kresby. Most při bootu startuje první (priority v jeho manifestu), kresby se
    // na něj napojí i později (onMostChange), bez něj platí záloha (shim). Na sprava závislost NENÍ (sprava si
    // panely stáhne sama přes export spravaPanels; cyklus závislostí umí KCDC 1.7.1 položit).
    resourceDependencies: [],
    exports: ["isBusy", "giveMaterial", "spravaPanels", "spravaSettings", "setUi", "isDrawing", "stats",
      "boardCreate", "boardRemove", "boardDraw", "boardPut", "boardClear", "boardGet", "boardInfo", "paperCode", "stopDrawing",
      "drawingPrepare", "boardShow", "drawingReady", "drawingDelete", "boardBake", "setCaptionFilter"],
    errorBehavior: "continue",
  },
};
writeFileSync(join(dist, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
const config = join(dist, "kresby_config.js");
if (!existsSync(config)) copyFileSync(join(root, "config", "kresby_config.example.js"), config);

const kb = (f) => (statSync(join(dist, f)).size / 1024).toFixed(1);
console.log(`kresby (KCDC ${types}): server ${kb("server.js")} KB, client ${kb("client.js")} KB, ui ${kb("ui/platno.js")} KB -> dist/kresby`);

// 4. nasazení do složky resource na serveru KCDC
const out = arg("--out");
if (out) {
  mkdirSync(join(out, "ui"), { recursive: true });
  mkdirSync(join(out, "ui", "kit"), { recursive: true });
  for (const f of ["server.js", "client.js", "package.json", "ui/platno.html", "ui/platno.js", "ui/kit/theme.css", "ui/kit/components.css", "ui/kit/kit.js"]) copyFileSync(join(dist, f), join(out, f));
  if (!existsSync(join(out, "kresby_config.js"))) copyFileSync(config, join(out, "kresby_config.js"));
  console.log("nasazeno do " + out + " (kresby_config.js se nepřepisuje)");
}
