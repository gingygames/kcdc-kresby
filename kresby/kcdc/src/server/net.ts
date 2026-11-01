// Zprávy mezi serverem a klienty přes `most` (export "net", most/CONTRACT.md "Velké zprávy"): zprávy po částech,
// handler dostane složený objekt. Když most neběží, posílají kresby samy (shared/net.ts, událost kresby:part,
// stejný formát). Malé zprávy chodí vždy přímo (Events.onClient), most doručí jen složené z částí
// (`on(..., { direct: false })`), takže nic nepřijde dvakrát.
import { Assembler, PART_EV, split } from "../shared/net";

type MostNet = {
  send(player: Player | number, event: string, msg: unknown): boolean;
  on(event: string, handler: (p: Player, msg: unknown) => void, owner?: string, opts?: { direct?: boolean }): () => void;
};

function mostNet(): MostNet | null {
  try {
    const n = Exports.get("most", "net") as MostNet | null | undefined;
    return n && typeof n.send === "function" && typeof n.on === "function" ? n : null;
  } catch {
    return null;
  }
}

export const stats = { sent: 0, parts: 0, most: 0 };
const log = (t: string) => console.log("[kresby] " + t);

export function sendTo(p: Player, ev: string, msg: unknown) {
  stats.sent++;
  const n = mostNet();
  if (n) {
    try {
      if (n.send(p, ev, msg) !== false) return void stats.most++;
    } catch (e) {
      log("most.net.send: " + String(e));
    }
  }
  const json = JSON.stringify(msg);
  const parts = split(ev, json);
  if (!parts) return void p.emit(ev, json);
  stats.parts += parts.length;
  for (const part of parts) p.emit(PART_EV, JSON.stringify(part));
}

const handlers = new Map<string, (p: Player, m: any) => void>();
const asm = new Map<number, Assembler>();
const parse = (m: unknown) => (typeof m === "string" ? JSON.parse(m) : m);

/** událost od klienta (přes most, nebo přímo / po částech kresby:part, když most neběží) */
export function onClient(ev: string, f: (p: Player, m: any) => void) {
  handlers.set(ev, f);
  Events.onClient(ev, (...a: any[]) => {
    const [p, m] = a as [Player, unknown];
    f(p, parse(m));
  });
  mostOn(ev, f);
}

function mostOn(ev: string, f: (p: Player, m: any) => void) {
  try {
    mostNet()?.on(ev, (p, m) => f(p, parse(m)), "kresby", { direct: false });
  } catch (e) {
    log("most.net.on: " + String(e));
  }
}

Events.onClient(PART_EV, (...args: any[]) => {
  const [p, raw] = args as [Player, unknown];
  let a = asm.get(p.id);
  if (!a) asm.set(p.id, (a = new Assembler()));
  const done = a.add(raw);
  if (done) handlers.get(done.event)?.(p, JSON.parse(done.json));
});

/** most (znovu) naběhl: zaregistrovat posluchače u něj (handlery na starém mostu zanikly s ním) */
export function mostStarted() {
  for (const [ev, f] of handlers) mostOn(ev, f);
}

export function forget(p: Player) {
  asm.delete(p.id);
}
