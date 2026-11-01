// Definice pro Items.register z CustomItemDef – sdílí ji standalone adaptér i nativní záloha shimu.
// Pravidla (ověřeno sondou na KCDC 1.7.2, 26. 10. 2026):
//  - {model, icon} bez visual projde (vlastní model i ikona); {visual, model} i {visual, model, icon} projde
//  - model bez icon a bez visual = "Custom items require a visual, or their own model and icon"
//  - model začínající "objects/" = chyba (cesta je relativní k Objects/); neexistující model server nekontroluje
//  - KCDC 1.7.1 model/icon/material nezná a hodí chybu -> druhý pokus bez nich, se vzhledem visual ?? base
import type { CustomItemDef } from "./contract";

export interface ItemRegistration {
  name: string;
  description?: string;
  visual?: string;
  model?: string;
  material?: string;
  icon?: string;
  weight: number;
  price?: number;
  stackable?: boolean;
  usable?: boolean;
  useLabel?: string;
}

/** Pokusy o registraci v pořadí: s vlastním modelem (je-li), pak bez něj (starší server). */
export function itemRegistrations(def: CustomItemDef): ItemRegistration[] {
  const base: ItemRegistration = {
    name: def.name, description: def.description, weight: def.weight ?? 0.1,
    price: def.price, stackable: def.stackable, usable: def.usable, useLabel: def.useLabel,
  };
  const plain = { ...base, visual: def.visual ?? def.base };
  if (!def.model && !def.icon) return [plain];
  const own: ItemRegistration = { ...base };
  if (def.model) {
    own.model = def.model.replace(/^objects[\\/]/i, ""); // server chce cestu bez "objects/"
    if (def.material) own.material = def.material;
  }
  if (def.icon) own.icon = def.icon;
  // vlastní model + ikona bez výslovného visual: nic si nepůjčovat (jinak by vzhled byl z base)
  if (def.visual) own.visual = def.visual;
  else if (!(own.model && own.icon)) own.visual = def.base; // ikona (nebo model) z base, zbytek vlastní
  return [own, plain];
}

/** Do logu bez dlouhé base64 ikony. */
export const describeRegistration = (r: ItemRegistration) =>
  JSON.stringify({ ...r, icon: r.icon ? `<${r.icon.length} znaků>` : undefined });

// ---------------------------------------------------------------------------------------------------------------
// Registrace s ohledem na neměnnost typů: Items.register je v rámci běhu serveru neměnný ("Identical repeats
// succeed; conflicts throw"). Změněná definice téhož id se proto za běhu neregistruje: platí dosavadní typ (stejný
// GUID, kusy v inventářích zůstávají) a nová se projeví po restartu serveru.
// Registr aktivních typů musí přežít restart resource (globalThis ho v KCDC 1.7.2 nepřežije, ověřeno), ne restart
// serveru: ukládá se do data/most/item-types.json s označením běhu serveru (pid + čas startu procesu).
declare const require: ((id: string) => any) | undefined;
declare const process: { pid: number; uptime(): number } | undefined;

interface ActiveType {
  guid: string;
  /** Podpis definice, se kterou typ skutečně vznikl. */
  sig: string;
  /** Ta definice bez ikony (do logu). */
  shown: string;
}
interface Registry {
  pid: number;
  start: number;
  types: Record<string, ActiveType>;
}

const FILE_DIR = "data/most";
const FILE = FILE_DIR + "/item-types.json";
const fs = (() => {
  try {
    const req = typeof require === "function" ? require : undefined;
    return req ? req("node:fs") : null;
  } catch {
    return null;
  }
})();
const run = () => {
  try {
    return process ? { pid: process.pid, start: Date.now() - process.uptime() * 1000 } : null;
  } catch {
    return null;
  }
};
const sameRun = (r: { pid: number; start: number } | null, x: Registry) => !!r && r.pid === x.pid && Math.abs(r.start - x.start) < 5000;
let registry: Registry | null = null;
function active(): Record<string, ActiveType> {
  const r = run();
  if (registry && sameRun(r, registry)) return registry.types;
  registry = { pid: r?.pid ?? 0, start: r?.start ?? 0, types: {} };
  try {
    if (fs?.existsSync(FILE)) {
      const saved = JSON.parse(fs.readFileSync(FILE, "utf8")) as Registry;
      if (sameRun(r, saved)) registry.types = saved.types ?? {};
    }
  } catch {}
  return registry.types;
}
function remember(id: string, guid: string, reg: ItemRegistration) {
  active()[id] = { guid, sig: signature(reg), shown: describeRegistration(reg) };
  try {
    fs?.mkdirSync(FILE_DIR, { recursive: true });
    fs?.writeFileSync(FILE + ".tmp", JSON.stringify(registry));
    fs?.renameSync(FILE + ".tmp", FILE);
  } catch {}
}

/** Podpis definice bez ohledu na pořadí klíčů a nevyplněná pole (FNV-1a, bez require). */
export function signature(r: ItemRegistration): string {
  const o = r as unknown as Record<string, unknown>;
  const text = JSON.stringify(Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => [k, o[k]]));
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16) + ":" + text.length;
}

/** Umí server vlastní model a ikonu? Podle verze modu (1.7.2+), neznámá verze = zkusit. */
export function serverHasOwnModels(): boolean {
  const v = (globalThis as any).ExecutionEnvironment?.modVersion as string | undefined;
  const m = typeof v === "string" ? v.match(/^(\d+)\.(\d+)\.(\d+)/) : null;
  if (!m) return true;
  const [a, b, c] = m.slice(1).map(Number);
  return a > 1 || (a === 1 && (b > 7 || (b === 7 && c >= 2)));
}

export type RegisterOutcome =
  | { kind: "registered"; guid: string; reg: ItemRegistration; fallback?: string }
  /** Za běhu se změnila definice: platí dosavadní typ, nová definice až po restartu serveru. */
  | { kind: "pending"; guid: string; active: string }
  /** Server nevzal žádnou podobu; conflict = id už nese jinou definici, kterou neznáme. */
  | { kind: "failed"; errors: string[]; conflict: boolean };

const CONFLICT = /already registered|another definition|conflict/i;

/**
 * Zaregistruje typ, nebo vrátí dosavadní. `previous` = definice, které mohly typ vytvořit dřív v tomto běhu serveru
 * (např. uložená v custom-items.json): zkusí se jako shodné opakování, aby se zjistil GUID existujícího typu.
 */
export function registerItemType(id: string, def: CustomItemDef, previous: CustomItemDef[] = []): RegisterOutcome {
  const own = serverHasOwnModels();
  // na serveru bez vlastních modelů se podoba s modelem vůbec nezkouší
  const all = itemRegistrations(def);
  const wanted = own ? all : all.filter((r) => r.model === undefined && r.icon === undefined);
  const known = active()[id];
  if (known) {
    if (known.sig === signature(wanted[0])) return { kind: "registered", guid: known.guid, reg: wanted[0] };
    return { kind: "pending", guid: known.guid, active: known.shown };
  }
  const errors: string[] = [];
  for (const reg of wanted) {
    try {
      const guid = Items.register(id, reg).toLowerCase();
      remember(id, guid, reg);
      // lepší podoba narazila na konflikt a tahle prošla jako shodné opakování: typ už existuje, změna čeká na restart
      if (errors.some((e) => CONFLICT.test(e))) return { kind: "pending", guid, active: describeRegistration(reg) };
      return { kind: "registered", guid, reg, fallback: errors[0] };
    } catch (e) {
      errors.push(String(e));
    }
  }
  const conflict = errors.some((e) => CONFLICT.test(e));
  if (conflict) {
    // typ vznikl v tomto běhu serveru s jinou definicí, kterou registr nezná (starší most, modul napřímo):
    // shodné opakování dřívější definice vrátí jeho GUID
    for (const prev of previous) {
      for (const reg of itemRegistrations(prev)) {
        try {
          const guid = Items.register(id, reg).toLowerCase();
          remember(id, guid, reg);
          return { kind: "pending", guid, active: describeRegistration(reg) };
        } catch {}
      }
    }
  }
  return { kind: "failed", errors, conflict };
}
