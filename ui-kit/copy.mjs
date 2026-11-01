// Zkopíruje sadu do výstupu modulu při buildu (stejný princip jako `most/shim`: modul si sadu bere z repa relativní cestou).
//
//   // v tools/build.mjs modulu (cesta podle hloubky, tady sprava/tools/build.mjs):
//   import { copyKit } from "../../ui-kit/copy.mjs";
//   copyKit(join(dist, "ui", "kit"));                       // theme.css, components.css, kit.js
//   copyKit(join(dist, "ui", "kit"), { js: false });        // jen CSS (stránka bez skriptů)
//
// V HTML: <link rel="stylesheet" href="kit/theme.css"> <link rel="stylesheet" href="kit/components.css"> <script src="kit/kit.js"></script>
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const KIT_FILES = ["theme.css", "components.css", "kit.js"];

/** zkopíruje soubory sady do `dest`; vrací seznam zkopírovaných jmen */
export function copyKit(dest, { js = true, css = true } = {}) {
  mkdirSync(dest, { recursive: true });
  const names = KIT_FILES.filter((f) => (f.endsWith(".js") ? js : css));
  for (const f of names) cpSync(join(here, f), join(dest, f));
  return names;
}
