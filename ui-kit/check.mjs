// Kontrola sady: kontrasty dvojic barev z theme.css (text aspoň 4,5:1, ovládací prvky a velké písmo aspoň 3:1).
//   node ui-kit/check.mjs        (vrací nenulový kód, když něco nevyhovuje)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** barvy z theme.css: { "k-text": "#f1e8d3", ... } (jen #rrggbb) */
export function tokens(css = readFileSync(join(here, "theme.css"), "utf8")) {
  const out = {};
  for (const m of css.matchAll(/--(k-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}

const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** [popředí, pozadí, nejmenší poměr, k čemu] */
export const PAIRS = [
  ["k-text", "k-bg", 4.5, "text na pozadí"],
  ["k-text", "k-surface", 4.5, "text na ploše"],
  ["k-text", "k-surface-2", 4.5, "text na zvýšené ploše"],
  ["k-text", "k-raised", 4.5, "text na toastu"],
  ["k-text", "k-input", 4.5, "text v poli"],
  ["k-muted", "k-bg", 4.5, "tlumený text na pozadí"],
  ["k-muted", "k-surface", 4.5, "tlumený text na ploše"],
  ["k-muted", "k-surface-2", 4.5, "tlumený text na zvýšené ploše"],
  ["k-muted", "k-raised", 4.5, "tlumený text na toastu"],
  ["k-accent", "k-bg", 4.5, "akcentní text na pozadí"],
  ["k-accent", "k-surface", 4.5, "akcentní text na ploše"],
  ["k-accent-ink", "k-accent", 4.5, "text tlačítka"],
  ["k-accent-ink", "k-accent-hover", 4.5, "text tlačítka při najetí"],
  ["k-on-solid", "k-err-solid", 4.5, "text nebezpečného tlačítka"],
  ["k-on-solid", "k-err-solid-hover", 4.5, "text nebezpečného tlačítka při najetí"],
  ["k-ok", "k-surface", 4.5, "ok na ploše"],
  ["k-warn", "k-surface", 4.5, "varování na ploše"],
  ["k-err", "k-surface", 4.5, "chyba na ploše"],
  ["k-info", "k-surface", 4.5, "info na ploše"],
  ["k-ok", "k-bg", 4.5, "ok na pozadí"],
  ["k-err", "k-bg", 4.5, "chyba na pozadí"],
  ["k-err", "k-raised", 4.5, "chyba na toastu"],
  ["k-paper-text", "k-paper", 4.5, "text na papíru"],
  ["k-paper-text", "k-paper-2", 4.5, "text na tmavším papíru"],
  ["k-paper-muted", "k-paper", 4.5, "tlumený text na papíru"],
  ["k-paper-muted", "k-paper-2", 4.5, "tlumený text na tmavším papíru"],
  ["k-paper-accent", "k-paper", 4.5, "odkaz na papíru"],
  ["k-line", "k-bg", 1.5, "ohraničení (dekorace)"],
  ["k-faint", "k-input", 3, "okraj přepínače a pole"],
  ["k-accent", "k-input", 3, "zaostření a zapnutý přepínač"],
];

export function failures(t = tokens()) {
  const bad = [];
  for (const [fg, bg, min, what] of PAIRS) {
    if (!t[fg] || !t[bg]) bad.push(`${fg}/${bg}: chybí barva v theme.css`);
    else if (contrast(t[fg], t[bg]) < min) bad.push(`${what}: ${fg} ${t[fg]} na ${bg} ${t[bg]} = ${contrast(t[fg], t[bg]).toFixed(2)}:1 (potřeba ${min}:1)`);
  }
  return bad;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const t = tokens();
  for (const [fg, bg, min, what] of PAIRS) console.log(`${contrast(t[fg], t[bg]).toFixed(2).padStart(6)}:1  (min ${min})  ${what}`);
  const bad = failures(t);
  if (bad.length) {
    console.error("\nNevyhovuje:\n  " + bad.join("\n  "));
    process.exit(1);
  }
  console.log("\nKontrasty v pořádku.");
}
