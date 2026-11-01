// Zprávy klienta přes `most` (export "net": emitServer, on; po částech, handler dostane složený objekt).
// Bez mostu přímo, velké po částech kresby:part (shared/net.ts). Malé zprávy chodí vždy přímo (Events.on),
// most doručí jen složené z částí (`on(..., { direct: false })`), takže nic nepřijde dvakrát.
import { Assembler, PART_EV, split } from "../shared/net";

type MostNet = { emitServer(event: string, msg: unknown): unknown; on(event: string, handler: (msg: unknown) => void, owner?: string, opts?: { direct?: boolean }): unknown };

function mostNet(): MostNet | null {
  try {
    const n = Exports.get("most", "net") as MostNet | null | undefined;
    return n && typeof n.on === "function" && typeof n.emitServer === "function" ? n : null;
  } catch {
    return null;
  }
}

const handlers = new Map<string, (m: any) => void>();
const asm = new Assembler();
const parse = (m: unknown) => (typeof m === "string" ? JSON.parse(m) : m);

/** posluchač události serveru; zpráva už je rozbalený objekt */
export function listen(ev: string, f: (m: any) => void) {
  handlers.set(ev, f);
  Events.on(ev, (m: unknown) => {
    f(parse(m));
  });
  mostOn(ev, f);
}

function mostOn(ev: string, f: (m: any) => void) {
  try {
    mostNet()?.on(ev, (m) => f(parse(m)), "kresby", { direct: false });
  } catch (e) {
    console.log("[kresby] most.net.on: " + String(e));
  }
}

Events.on(PART_EV, (raw: unknown) => {
  const done = asm.add(raw);
  if (done) handlers.get(done.event)?.(JSON.parse(done.json));
});

/** zpráva serveru (dávky tahů mohou mít desítky KB) */
export function emitServer(ev: string, msg: unknown) {
  const n = mostNet();
  if (n) {
    try {
      n.emitServer(ev, msg);
      return;
    } catch (e) {
      console.log("[kresby] most.net.emitServer: " + String(e));
    }
  }
  const parts = split(ev, JSON.stringify(msg));
  if (!parts) return void Events.emitServer(ev, msg);
  for (const p of parts) Events.emitServer(PART_EV, p);
}

/** most (znovu) naběhl: zaregistrovat posluchače u něj */
export function useMost() {
  if (!mostNet()) return;
  for (const [ev, f] of handlers) mostOn(ev, f);
}
