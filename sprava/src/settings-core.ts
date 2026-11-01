// Nastavení modulů: čistá logika nad schématem (bez globálů KCDC). Stejný kód běží na serveru i v UI (build ho zabalí do ui/settings-core.js
// jako `window.SpravaSettingsCore`), takže stránka ověřuje, hledá a skrývá pole přesně jako server.
//   checkSchema    ověří schéma při registraci (chyby programátora = výjimka)
//   defaultsOf     hodnota ze `default` ve schématu
//   validate       ověří a normalizuje hodnotu, vrací chyby s cestou (skrytá pole `showIf` se neověřují)
//   evalShowIf     podmíněné zobrazení
//   diff           rozdíl dvou hodnot pro záznam změn
//   wireSchema     schéma pro UI (funkce vyhodnocené)
//   fieldAt, pick  pole / hodnota podle cesty
//   resolveDeepPath, searchFields   hluboké odkazy (`nastroje.tamburina`) a hledání v nastavení
import type {
  FileRef,
  ListField,
  SettingsError,
  SettingsField,
  SettingsObject,
  SettingsOption,
  SettingsPlace,
  SettingsPosition,
  SettingsValue,
  ShowIf,
} from "./settings-types";

export const FIELD_TYPES = [
  "string", "text", "number", "boolean", "select", "item", "place", "position", "list", "group",
  "color", "slider", "vector3", "offset", "file", "sound", "animation",
] as const;
const KEY = /^[A-Za-z0-9_.-]{1,48}$/;
const MAX_DEPTH = 8;
const MAX_LIST = 2000;
export const DEFAULT_MAX_FILE = 1024 * 1024;
export const HARD_MAX_FILE = 8 * 1024 * 1024;
export const REF_RE = /^[a-z]+:[A-Za-z0-9_./:-]{1,200}$/;
const TRIGGER_RE = /^[A-Za-z0-9_.:/ -]{1,120}$/;
const TAGS_RE = /^[A-Za-z0-9_+!,. -]{0,120}$/;

type DOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Item = DOmit<SettingsField, "key"> & { key?: string };

export interface ValidateHost {
  itemExists?(id: string, wearable?: boolean): boolean;
  /** pojmenované místo podle id (aktuální souřadnice), null = není */
  place?(id: string): SettingsPlace | null;
  /** existuje nahraný soubor (jen `fs:` odkazy Správy; cizí `ref` modulu se nekontrolují) */
  fileExists?(ref: string): boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const join = (path: string, k: string | number) => (path === "" ? String(k) : `${path}.${k}`);
const round = (n: number) => Math.round(n * 1000) / 1000;
const wrapDeg = (d: number) => round((((d + 180) % 360) + 360) % 360 - 180);
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function resolveOptions(f: { options?: SettingsOption[] | (() => SettingsOption[]) }): SettingsOption[] {
  try {
    return typeof f.options === "function" ? f.options() : f.options ?? [];
  } catch {
    return [];
  }
}

export function maxBytesOf(f: { maxBytes?: number }): number {
  return Math.min(HARD_MAX_FILE, Math.max(1, f.maxBytes ?? DEFAULT_MAX_FILE));
}

// ---------------------------------------------------------------------------
// podmíněné zobrazení

/** zásobník objektů od kořene po objekt, ve kterém pole leží (`raw` = vstup před normalizací, záloha pro ještě nezpracované klíče) */
export interface Frame {
  out: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

function lookup(stack: Frame[], ref: string): unknown {
  let i = stack.length - 1;
  let p = ref;
  if (p.startsWith("/")) {
    i = 0;
    p = p.slice(1);
  } else {
    while (p.startsWith("../")) {
      i--;
      p = p.slice(3);
    }
  }
  const fr = stack[i];
  if (!fr) return undefined;
  const keys = p.split(".").filter(Boolean);
  if (!keys.length) return undefined;
  let cur: unknown = fr.out[keys[0]] !== undefined ? fr.out[keys[0]] : fr.raw?.[keys[0]];
  for (const k of keys.slice(1)) cur = isObj(cur) ? cur[k] : Array.isArray(cur) && /^\d+$/.test(k) ? cur[Number(k)] : undefined;
  return cur;
}

const truthy = (v: unknown): boolean => !(v === undefined || v === null || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0));
const same = (a: unknown, b: unknown): boolean => a === b || (a !== null && b !== null && a !== undefined && b !== undefined && typeof a !== "object" && String(a) === String(b));

export function evalShowIf(c: ShowIf | undefined, stack: Frame[]): boolean {
  if (!c) return true;
  if ("all" in c) return c.all.every((x) => evalShowIf(x, stack));
  if ("any" in c) return c.any.some((x) => evalShowIf(x, stack));
  if ("not" in c) return !evalShowIf(c.not, stack);
  const v = lookup(stack, c.field);
  let used = false;
  const test = (ok: boolean) => ((used = true), ok);
  if (c.eq !== undefined && !test(same(v, c.eq))) return false;
  if (c.ne !== undefined && !test(!same(v, c.ne))) return false;
  if (c.in !== undefined && !test(c.in.some((x) => same(v, x)))) return false;
  if (c.nin !== undefined && !test(!c.nin.some((x) => same(v, x)))) return false;
  const n = typeof v === "number" ? v : Number(v);
  if (c.gt !== undefined && !test(Number.isFinite(n) && n > c.gt)) return false;
  if (c.gte !== undefined && !test(Number.isFinite(n) && n >= c.gte)) return false;
  if (c.lt !== undefined && !test(Number.isFinite(n) && n < c.lt)) return false;
  if (c.lte !== undefined && !test(Number.isFinite(n) && n <= c.lte)) return false;
  if (c.truthy !== undefined) return truthy(v) === c.truthy;
  return used ? true : truthy(v);
}

function showIfRefs(c: ShowIf, out: string[] = []): string[] {
  if ("all" in c) c.all.forEach((x) => showIfRefs(x, out));
  else if ("any" in c) c.any.forEach((x) => showIfRefs(x, out));
  else if ("not" in c) showIfRefs(c.not, out);
  else out.push(c.field);
  return out;
}

// ---------------------------------------------------------------------------
// schéma

/** ověří schéma při registraci; chyba = výjimka s cestou (špatné schéma je chyba modulu, ne hráče) */
export function checkSchema(fields: unknown, where = "schema", depth = 0): void {
  if (!Array.isArray(fields)) throw new Error(`sprava: ${where} musí být pole polí`);
  if (depth > MAX_DEPTH) throw new Error(`sprava: ${where} je moc hluboko (nejvýš ${MAX_DEPTH})`);
  const seen = new Set<string>();
  for (const f of fields as Item[]) {
    if (!isObj(f)) throw new Error(`sprava: ${where}: pole musí být objekt`);
    if (typeof f.key !== "string" || !KEY.test(f.key)) throw new Error(`sprava: ${where}: neplatný key "${String(f.key)}" (písmena, číslice, _ . -)`);
    if (seen.has(f.key)) throw new Error(`sprava: ${where}: key ${f.key} je dvakrát`);
    seen.add(f.key);
    checkField(f, `${where}.${f.key}`, depth);
  }
  for (const f of fields as Item[]) {
    if (!f.showIf) continue;
    for (const ref of showIfRefs(f.showIf)) {
      const first = ref.startsWith("/") || ref.startsWith("../") ? null : ref.split(".")[0];
      if (first !== null && !seen.has(first)) throw new Error(`sprava: ${where}.${f.key}: showIf odkazuje na pole "${ref}", které tu není (sourozenci: ${[...seen].join(", ")})`);
    }
  }
}

function checkShowIf(c: unknown, where: string): void {
  if (!isObj(c)) throw new Error(`sprava: ${where}: showIf musí být objekt`);
  if ("all" in c || "any" in c) {
    const list = (c.all ?? c.any) as unknown;
    if (!Array.isArray(list) || !list.length) throw new Error(`sprava: ${where}: showIf all/any potřebuje neprázdné pole`);
    list.forEach((x, i) => checkShowIf(x, `${where}[${i}]`));
  } else if ("not" in c) checkShowIf(c.not, where);
  else if (typeof c.field !== "string" || !c.field) throw new Error(`sprava: ${where}: showIf potřebuje field`);
}

function checkField(f: Item, where: string, depth: number): void {
  if (!(FIELD_TYPES as readonly string[]).includes(f.type as string)) throw new Error(`sprava: ${where}: neznámý typ "${String(f.type)}"`);
  if (f.showIf !== undefined) checkShowIf(f.showIf, where);
  if (f.type === "select" && !(Array.isArray(f.options) || typeof f.options === "function")) throw new Error(`sprava: ${where}: select potřebuje options`);
  if (f.type === "slider" && !(finite(f.min) && finite(f.max) && f.min < f.max)) throw new Error(`sprava: ${where}: slider potřebuje min < max`);
  if (f.type === "file" && !(Array.isArray(f.accept) && f.accept.length && f.accept.every((a) => a === "ogg" || a === "png"))) {
    throw new Error(`sprava: ${where}: file potřebuje accept: ["ogg"] a/nebo ["png"]`);
  }
  if (f.type === "group") checkSchema(f.fields, `${where}.fields`, depth + 1);
  if (f.type === "list") {
    if (!isObj(f.item)) throw new Error(`sprava: ${where}: list potřebuje item`);
    if ((f.item as Item).type === "list") throw new Error(`sprava: ${where}: seznam v seznamu nejde, vlož mezi ně group`);
    checkField(f.item as Item, `${where}.item`, depth + 1);
    const it = f.item as Item;
    const keys = it.type === "group" ? new Set(it.fields.map((x) => x.key)) : null;
    for (const k of ["itemLabel", "unique"] as const) {
      if (f[k] !== undefined && (!keys || !keys.has(f[k] as string))) throw new Error(`sprava: ${where}: ${k} "${String(f[k])}" není pole položky (položka musí být group)`);
    }
    for (const [i, t] of (f.templates ?? []).entries()) {
      if (!t || typeof t.label !== "string" || !isObj(t.value)) throw new Error(`sprava: ${where}: templates[${i}] potřebuje label a value (objekt)`);
      if (it.type !== "group") throw new Error(`sprava: ${where}: templates jdou jen u seznamu skupin`);
    }
  }
}

// ---------------------------------------------------------------------------
// výchozí hodnoty a normalizace

const ZERO3 = () => ({ x: 0, y: 0, z: 0 });
const ZERO_OFFSET = () => ({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 });

function emptyOf(f: Item): SettingsValue {
  switch (f.type) {
    case "string":
    case "text":
      return "";
    case "boolean":
      return false;
    case "list":
      return [];
    case "group":
      return defaultsOf(f.fields);
    case "slider":
      return f.min;
    case "vector3":
      return ZERO3();
    case "offset":
      return ZERO_OFFSET();
    default:
      return null;
  }
}

function defaultOf(f: Item): SettingsValue {
  const d = (f as { default?: unknown }).default;
  if (d !== undefined) return clone(d as SettingsValue);
  if (f.type === "list") return [];
  return emptyOf(f);
}

export function defaultsOf(fields: SettingsField[]): SettingsObject {
  const out: SettingsObject = {};
  for (const f of fields) out[f.key] = f.type === "group" ? defaultsOf(f.fields) : defaultOf(f);
  return out;
}

/** výchozí hodnota jedné položky seznamu (pro „Přidat“) */
export function itemDefault(f: ListField | (DOmit<ListField, "key"> & { key?: string })): SettingsValue {
  return defaultOf(f.item as Item);
}

export function clone<T extends SettingsValue>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export interface Validated {
  value: SettingsObject;
  errors: SettingsError[];
}

/** ověří a normalizuje strom podle schématu; `value` je vždy použitelný (i s chybami), `errors` prázdné = lze uložit */
export function validate(fields: SettingsField[], input: unknown, host: ValidateHost = {}): Validated {
  const errors: SettingsError[] = [];
  const value = object(fields, isObj(input) ? input : {}, "", errors, host, []);
  return { value, errors };
}

function object(fields: SettingsField[], input: Record<string, unknown>, path: string, errors: SettingsError[], host: ValidateHost, stack: Frame[]): SettingsObject {
  const out: SettingsObject = {};
  const st = [...stack, { out, raw: input }];
  const pending: { f: SettingsField; errs: SettingsError[] }[] = [];
  for (const f of fields) {
    const errs: SettingsError[] = [];
    out[f.key] = field(f, input[f.key], join(path, f.key), errs, host, st);
    pending.push({ f, errs });
  }
  // podmínky se vyhodnocují až nad hotovým objektem; skrytá pole se neověřují
  for (const { f, errs } of pending) if (!f.showIf || evalShowIf(f.showIf, st)) errors.push(...errs);
  return out;
}

function field(f: Item, raw: unknown, path: string, errors: SettingsError[], host: ValidateHost, stack: Frame[]): SettingsValue {
  const label = f.label ?? f.key ?? "Pole";
  const err = (message: string) => void errors.push({ path, message });
  const v = raw === undefined ? defaultOf(f) : raw;

  switch (f.type) {
    case "string":
    case "text": {
      if (v !== null && typeof v !== "string" && typeof v !== "number") {
        err(`${label}: musí být text.`);
        return "";
      }
      let s = v === null ? "" : String(v);
      if (f.type === "string") s = s.replace(/[\r\n]+/g, " ");
      s = s.trim();
      const max = f.maxLength ?? (f.type === "text" ? 4000 : 500);
      if (s.length > max) {
        err(`${label}: nejvýš ${max} znaků.`);
        s = s.slice(0, max);
      }
      if (f.required && s === "") err(`${label}: je povinné.`);
      return s;
    }
    case "number":
    case "slider": {
      if (v === null || v === "") {
        if (f.type === "slider") return f.min;
        if (f.required) err(`${label}: je povinné.`);
        return null;
      }
      const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
      if (!finite(n)) {
        err(`${label}: není číslo.`);
        return f.type === "slider" ? f.min : null;
      }
      if (f.integer && !Number.isInteger(n)) err(`${label}: musí být celé číslo.`);
      if (f.min !== undefined && n < f.min) err(`${label}: nejméně ${f.min}.`);
      if (f.max !== undefined && n > f.max) err(`${label}: nejvýš ${f.max}.`);
      return n;
    }
    case "boolean":
      return v === true || v === 1 || v === "true" || v === "1" || v === "on";
    case "select": {
      if (v === null || v === "") {
        if (f.required) err(`${label}: vyber hodnotu.`);
        return null;
      }
      const hit = resolveOptions(f).find((o) => String(o.value) === String(v));
      if (!hit) {
        err(`${label}: neplatná volba.`);
        return null;
      }
      return hit.value;
    }
    case "item": {
      if (v === null || v === "") {
        if (f.required) err(`${label}: vyber předmět.`);
        return null;
      }
      const id = String(v).trim();
      if (host.itemExists && !host.itemExists(id, f.wearable)) err(`${label}: ${f.wearable ? `„${id}“ nejde obléct (není v Inventory.classes())` : `předmět „${id}“ server nezná`}.`);
      return id;
    }
    case "place": {
      if (v === null) {
        if (f.required) err(`${label}: vyber místo.`);
        return null;
      }
      if (!isObj(v) || typeof v.id !== "string") {
        err(`${label}: neplatné místo.`);
        return null;
      }
      const hit = host.place?.(v.id);
      if (hit) return { ...hit };
      if (finite(v.x) && finite(v.y) && finite(v.z)) return { id: v.id, name: String(v.name ?? v.id), x: v.x, y: v.y, z: v.z, level: String(v.level ?? "") };
      err(`${label}: místo „${v.id}“ neexistuje.`);
      return null;
    }
    case "position": {
      if (v === null) {
        if (f.required) err(`${label}: zadej polohu.`);
        return null;
      }
      if (!isObj(v) || !finite(v.x) || !finite(v.y) || !finite(v.z)) {
        err(`${label}: poloha potřebuje čísla x, y, z.`);
        return null;
      }
      const out: SettingsPosition = { x: round(v.x), y: round(v.y), z: round(v.z) };
      if (f.yaw !== false) {
        const yaw = v.yaw === undefined || v.yaw === null ? 0 : v.yaw;
        if (!finite(yaw)) err(`${label}: směr musí být číslo.`);
        else out.yaw = wrapDeg(yaw as number);
      }
      return out as unknown as SettingsValue;
    }
    case "color": {
      if (v === null || v === "") {
        if (f.required) err(`${label}: vyber barvu.`);
        return null;
      }
      const s = String(v).trim().toLowerCase();
      const ok = f.alpha ? /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(s) : /^#[0-9a-f]{6}$/.test(s);
      if (!ok) {
        err(`${label}: barva musí být ${f.alpha ? "#rrggbb nebo #rrggbbaa" : "#rrggbb"}.`);
        return null;
      }
      return s;
    }
    case "vector3": {
      const o = isObj(v) ? v : null;
      if (v !== null && !o) err(`${label}: musí být { x, y, z }.`);
      const out: Record<string, number> = {};
      for (const k of ["x", "y", "z"]) {
        const n = o ? o[k] : 0;
        const num = n === undefined || n === null || n === "" ? 0 : Number(n);
        if (!finite(num)) {
          err(`${label}: ${k} není číslo.`);
          out[k] = 0;
          continue;
        }
        if (f.min !== undefined && num < f.min) err(`${label}: ${k} nejméně ${f.min}.`);
        if (f.max !== undefined && num > f.max) err(`${label}: ${k} nejvýš ${f.max}.`);
        out[k] = round(num);
      }
      return out;
    }
    case "offset": {
      const o = isObj(v) ? v : null;
      if (v !== null && !o) err(`${label}: musí být { x, y, z, rx, ry, rz }.`);
      const range = f.range ?? 1;
      const out: Record<string, number> = {};
      for (const k of ["x", "y", "z", "rx", "ry", "rz"]) {
        const n = o ? o[k] : 0;
        const num = n === undefined || n === null || n === "" ? 0 : Number(n);
        if (!finite(num)) {
          err(`${label}: ${k} není číslo.`);
          out[k] = 0;
          continue;
        }
        if (k.length === 1) {
          if (Math.abs(num) > range) err(`${label}: posun ${k} nejvýš ±${range} m.`);
          out[k] = round(num);
        } else out[k] = wrapDeg(num);
      }
      return out;
    }
    case "file": {
      if (v === null || v === "") {
        if (f.required) err(`${label}: nahraj soubor.`);
        return null;
      }
      const ref = fileRef(v, f.accept, maxBytesOf(f), host, label, err);
      return (ref ?? null) as unknown as SettingsValue;
    }
    case "sound": {
      if (v === null || v === "") {
        if (f.required) err(`${label}: vyber zvuk.`);
        return null;
      }
      const s = String(v).trim();
      if (s.startsWith("file:")) {
        const ref = s.slice(5);
        if (!f.allowFile) err(`${label}: nahraný soubor tu není povolený.`);
        else if (!REF_RE.test(ref)) err(`${label}: neplatný odkaz na soubor.`);
        else if (host.fileExists && ref.startsWith("fs:") && !host.fileExists(ref)) err(`${label}: nahraný soubor už na serveru není.`);
        return s;
      }
      if (!TRIGGER_RE.test(s)) {
        err(`${label}: neplatný název zvuku.`);
        return s.slice(0, 120);
      }
      if (f.strict && !resolveOptions(f).some((o) => String(o.value) === s)) err(`${label}: zvuk „${s}“ není v nabídce.`);
      return s;
    }
    case "animation": {
      if (v === null) {
        if (f.required) err(`${label}: vyber animaci.`);
        return null;
      }
      if (!isObj(v)) {
        err(`${label}: neplatná animace.`);
        return null;
      }
      const fragment = String(v.fragment ?? "").trim();
      const tags = String(v.tags ?? "").trim();
      const clip = String(v.clip ?? "").trim();
      if (fragment.length > 120 || !TAGS_RE.test(tags) || clip.length > 200) err(`${label}: fragment, tagy nebo klip jsou moc dlouhé / mají zakázané znaky.`);
      if (clip && !f.clip) err(`${label}: klip tu není povolený.`);
      if (!fragment && !clip) {
        if (f.required) err(`${label}: vyber fragment${f.clip ? " nebo klip" : ""}.`);
        return null;
      }
      return { fragment, tags, clip, loop: v.loop === true };
    }
    case "group": {
      if (!isObj(v)) {
        err(`${label}: neplatná skupina.`);
        return defaultsOf(f.fields);
      }
      return object(f.fields, v, path, errors, host, stack);
    }
    case "list":
      return list(f, v, path, errors, host, stack);
  }
}

function fileRef(v: unknown, accept: ("ogg" | "png")[], max: number, host: ValidateHost, label: string, err: (m: string) => void): FileRef | null {
  if (!isObj(v) || typeof v.ref !== "string" || !REF_RE.test(v.ref)) {
    err(`${label}: neplatný odkaz na soubor.`);
    return null;
  }
  const kind = v.kind === "png" ? "png" : "ogg";
  if (!accept.includes(kind)) err(`${label}: povolené typy: ${accept.join(", ")}.`);
  const size = finite(v.size) ? v.size : 0;
  if (size > max) err(`${label}: soubor je větší než ${Math.round(max / 1024)} kB.`);
  if (host.fileExists && v.ref.startsWith("fs:") && !host.fileExists(v.ref)) err(`${label}: soubor už na serveru není, nahraj ho znovu.`);
  return { ref: v.ref, name: String(v.name ?? v.ref).slice(0, 120), size, kind };
}

function list(
  f: ListField | (DOmit<ListField, "key"> & { key?: string }),
  v: unknown,
  path: string,
  errors: SettingsError[],
  host: ValidateHost,
  stack: Frame[],
): SettingsValue[] {
  const label = f.label ?? f.key ?? "Seznam";
  const err = (p: string, message: string) => void errors.push({ path: p, message });
  if (!Array.isArray(v)) {
    err(path, `${label}: musí být seznam.`);
    return [];
  }
  let arr = v;
  if (arr.length > MAX_LIST) {
    err(path, `${label}: nejvýš ${MAX_LIST} položek.`);
    arr = arr.slice(0, MAX_LIST);
  }
  if (f.min !== undefined && arr.length < f.min) err(path, `${label}: nejméně ${f.min} položek.`);
  if (f.max !== undefined && arr.length > f.max) err(path, `${label}: nejvýš ${f.max} položek.`);
  if (f.required && arr.length === 0) err(path, `${label}: přidej aspoň jednu položku.`);
  const item = f.item as Item;
  const out = arr.map((x, i) => field(item, x, join(path, i), errors, host, stack));
  if (f.unique) {
    const seen = new Map<string, number>();
    out.forEach((x, i) => {
      const val = isObj(x) ? (x as Record<string, unknown>)[f.unique as string] : undefined;
      if (val === undefined || val === null || val === "") return;
      const k = String(val);
      if (seen.has(k)) err(join(join(path, i), f.unique as string), `${label}: „${k}“ už je v položce ${seen.get(k)! + 1}.`);
      else seen.set(k, i);
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// rozdíl pro záznam změn

export interface Change {
  path: string;
  from: string;
  to: string;
}

const short = (v: unknown): string => {
  if (v === undefined) return "∅";
  const s = JSON.stringify(v) ?? "∅";
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
};

/** změny `a` -> `b` po listech; položky seznamu podle indexu, přidané/odebrané jako ∅ */
export function diff(a: SettingsValue | undefined, b: SettingsValue | undefined, path = "", out: Change[] = [], limit = 60): Change[] {
  if (out.length >= limit) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k] as SettingsValue, b[k] as SettingsValue, join(path, k), out, limit);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff(a[i], b[i], join(path, i), out, limit);
  } else out.push({ path: path || "(vše)", from: short(a), to: short(b) });
  return out;
}

// ---------------------------------------------------------------------------
// schéma pro UI

/** kopie schématu bez funkcí (select.options a sound.options vyhodnocené) */
export function wireSchema(fields: SettingsField[]): SettingsField[] {
  return fields.map((f) => wireField(f)) as SettingsField[];
}

function wireField(f: Item): Item {
  const out: Record<string, unknown> = { ...f };
  if (f.type === "select" || (f.type === "sound" && f.options)) out.options = resolveOptions(f);
  if (f.type === "group") out.fields = wireSchema(f.fields);
  if (f.type === "list") out.item = wireField(f.item as Item);
  return out as Item;
}

/** pole podle cesty `["origins", "list", 2, "arrival"]` (indexy seznamů přeskočí na schéma položky) */
export function fieldAt(fields: SettingsField[], path: (string | number)[]): Item | null {
  let cur: Item | null = null;
  for (const k of path) {
    if (cur && cur.type === "list") {
      if (typeof k !== "number" && !/^\d+$/.test(String(k))) return null;
      cur = cur.item as Item;
      continue;
    }
    const arr: SettingsField[] | null = cur ? (cur.type === "group" ? cur.fields : null) : fields;
    if (!arr) return null;
    const hit: SettingsField | undefined = arr.find((x) => x.key === String(k));
    if (!hit) return null;
    cur = hit;
  }
  return cur;
}

/** hodnota podle cesty ["origins", 2, "name"] */
export function pick(value: SettingsValue, path: (string | number)[]): SettingsValue | undefined {
  let cur: unknown = value;
  for (const k of path) {
    if (Array.isArray(cur) && (typeof k === "number" || /^\d+$/.test(String(k)))) cur = cur[Number(k)];
    else if (isObj(cur)) cur = cur[String(k)];
    else return undefined;
  }
  return cur as SettingsValue | undefined;
}

// ---------------------------------------------------------------------------
// hluboké odkazy a hledání

export interface DeepPath {
  /** přesná cesta k nejhlubšímu nalezenému poli / položce */
  path: (string | number)[];
  /** zbytek odkazu, který se nepodařilo najít */
  rest: string[];
}

/**
 * Odkaz `nastroje.tamburina` -> cesta. Segment u seznamu je index, nebo hodnota klíče `unique` / `itemLabel` / `id` / `key` / `name`
 * položky. Skupina, která má jediné pole typu seznam, se může vynechat (`kits.sedlak` = `kits.list.sedlak`).
 */
export function resolveDeepPath(schema: SettingsField[], value: SettingsObject | undefined, link: string): DeepPath {
  const segs = String(link ?? "").split(".").map((s) => s.trim()).filter(Boolean);
  const path: (string | number)[] = [];

  const walkFields = (fields: SettingsField[], val: unknown, rest: string[]): string[] => {
    if (!rest.length) return rest;
    const f = fields.find((x) => x.key === rest[0]);
    if (f) {
      path.push(f.key);
      return walkField(f as Item, isObj(val) ? val[f.key] : undefined, rest.slice(1));
    }
    const lists = fields.filter((x) => x.type === "list");
    if (fields.length === 1 && lists.length === 1) {
      path.push(lists[0].key);
      return walkField(lists[0] as Item, isObj(val) ? val[lists[0].key] : undefined, rest);
    }
    return rest;
  };

  const walkField = (f: Item, val: unknown, rest: string[]): string[] => {
    if (!rest.length) return rest;
    if (f.type === "group") return walkFields(f.fields, val, rest);
    if (f.type === "list") {
      const arr = Array.isArray(val) ? val : [];
      const s = rest[0];
      let idx = -1;
      if (/^\d+$/.test(s)) idx = Number(s) < arr.length ? Number(s) : -1;
      else {
        const keys = [f.unique, f.itemLabel, "id", "key", "name"].filter((k): k is string => !!k);
        idx = arr.findIndex((it) => (isObj(it) ? keys.some((k) => it[k] !== undefined && fold(String(it[k])) === fold(s)) : fold(String(it)) === fold(s)));
      }
      if (idx < 0) return rest;
      path.push(idx);
      const item = f.item as Item;
      return item.type === "group" ? walkFields(item.fields, arr[idx], rest.slice(1)) : rest.slice(1);
    }
    return rest;
  };

  const rest = walkFields(schema, value, segs);
  return { path, rest };
}

export interface SearchHit {
  path: (string | number)[];
  label: string;
  /** nadřazené skupiny / položky pro zobrazení „Původy › Kupec › Výbava“ */
  crumbs: string[];
  /** shoda v názvu / nápovědě pole, nebo v hodnotě */
  where: "label" | "value";
  /** zkrácená hodnota u shody v hodnotě */
  value?: string;
}

/**
 * Hledá v názvech, klíčích a nápovědě polí a (když je `value`) v textových hodnotách, včetně položek seznamů.
 * Všechna slova dotazu musí být v poli; bez diakritiky a bez ohledu na velikost písmen.
 */
export function searchFields(schema: SettingsField[], value: SettingsObject | undefined, query: string, limit = 50): SearchHit[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: SearchHit[] = [];
  const add = (f: Item, path: (string | number)[], crumbs: string[], label: string, v: unknown) => {
    if (hits.length >= limit) return;
    const labelHay = fold(`${label} ${f.key ?? ""} ${f.help ?? ""}`);
    let valueText = "";
    if (typeof v === "string" || typeof v === "number") valueText = String(v);
    else if (isObj(v) && typeof v.name === "string") valueText = v.name;
    const valueHay = fold(valueText);
    if (words.every((w) => labelHay.includes(w))) hits.push({ path, label, crumbs, where: "label" });
    else if (valueText && words.every((w) => (labelHay + " " + valueHay).includes(w))) hits.push({ path, label, crumbs, where: "value", value: valueText.slice(0, 60) });
  };
  /** `fixed` = hledání jen ve schématu (bez hodnot): pole uvnitř položek seznamu odkazují na samotný seznam */
  const walkFields = (fields: SettingsField[], val: unknown, path: (string | number)[], crumbs: string[], fixed?: (string | number)[]) => {
    for (const f of fields) {
      const p = fixed ?? [...path, f.key];
      const v = isObj(val) ? val[f.key] : undefined;
      const label = f.label ?? f.key;
      add(f as Item, p, crumbs, label, v);
      if (f.type === "group") walkFields(f.fields, v, p, [...crumbs, label], fixed);
      else if (f.type === "list") {
        const arr = Array.isArray(v) ? v : [];
        const item = f.item as Item;
        if (value === undefined && item.type === "group") walkFields(item.fields, undefined, p, [...crumbs, label, "položka"], p);
        arr.forEach((it, i) => {
          const ip = [...p, i];
          const title = isObj(it) ? String(it[f.itemLabel ?? f.unique ?? "name"] ?? "") : String(it ?? "");
          const itemLabel = `#${i + 1}${title ? " " + title : ""}`;
          const unique = isObj(it) && f.unique ? String(it[f.unique] ?? "") : "";
          add({ ...item, key: unique || undefined, label: itemLabel } as Item, ip, [...crumbs, label], itemLabel, isObj(it) ? title : it);
          if (item.type === "group") walkFields(item.fields, it, ip, [...crumbs, label, itemLabel]);
        });
      }
    }
  };
  walkFields(schema, value, [], []);
  return hits;
}
