// Velké zprávy po částech. KCDC pošle událost jako jeden paket a zprávu nad ~64 KB usekne (klient pak hlásí
// "Failed to parse event payload JSON"). Kresba v CanvasMsg/ViewMsg má až 16 KiB, okolí s mnoha vývěskami víc.
// Drátový formát je stejný jako sprava/src/chunks.ts (Part {k,e,i,n,d}), jen pod vlastní událostí; až `most`
// nabídne posílání po částech (export "net"), jde zpráva přes něj (server/net.ts, client/net.ts).

export const PART_EV = "kresby:part";
export const LIMIT = 12000; // znaků JSON; česky v UTF-8 až 3 bajty na znak
export const CHUNK = 8000;
const MAX_PARTS = 256;
const MAX_PENDING = 8;
const TTL = 30000;

export interface Part {
  k: string;
  e: string;
  i: number;
  n: number;
  d: string;
}

let seq = 0;

/** části zprávy, nebo null, když se vejde do jednoho paketu */
export function split(event: string, json: string, size = CHUNK, limit = LIMIT): Part[] | null {
  if (json.length <= limit) return null;
  const k = Date.now().toString(36) + "." + (++seq).toString(36);
  const out: Part[] = [];
  for (let from = 0; from < json.length; ) {
    let to = Math.min(json.length, from + size);
    const last = json.charCodeAt(to - 1);
    if (to < json.length && last >= 0xd800 && last <= 0xdbff) to--; // nerozdělit pár náhrad
    out.push({ k, e: event, i: out.length, n: 0, d: json.slice(from, to) });
    from = to;
  }
  for (const p of out) p.n = out.length;
  return out;
}

/** skládá části; jedna instance na odesílatele */
export class Assembler {
  private pending = new Map<string, { e: string; n: number; parts: string[]; got: number; at: number }>();

  add(raw: unknown, now = Date.now()): { event: string; json: string } | null {
    let p: Partial<Part> | null;
    try {
      p = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<Part> | null;
    } catch {
      return null;
    }
    if (!p || typeof p.k !== "string" || typeof p.e !== "string" || typeof p.d !== "string") return null;
    const i = Number(p.i);
    const n = Number(p.n);
    if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || n > MAX_PARTS || i < 0 || i >= n) return null;
    for (const [id, x] of this.pending) if (now - x.at > TTL) this.pending.delete(id);
    let cur = this.pending.get(p.k);
    if (!cur) {
      if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
      cur = { e: p.e, n, parts: new Array<string>(n), got: 0, at: now };
      this.pending.set(p.k, cur);
    }
    if (cur.n !== n || cur.e !== p.e) return null;
    if (cur.parts[i] === undefined) {
      cur.parts[i] = p.d;
      cur.got++;
    }
    if (cur.got < cur.n) return null;
    this.pending.delete(p.k);
    return { event: cur.e, json: cur.parts.join("") };
  }
}
