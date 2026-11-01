// Správa kreseb: příkazy /kresby … a panel pro resource "sprava" (admin UI).
//
// Panel jde do sprava dvěma cestami (podle toho, co sprava umí): export "spravaPanels" (sprava si ho vezme sám,
// když resource kresby nastartuje) a Exports.get("sprava", "registerPanel")(def, "kresby"), když sprava už běží.
// Bez sprava zůstanou příkazy.

import * as assets from "./assets";
import * as sheets from "./props";
import * as settings from "./settings";
import { faceHeight, type Face } from "../shared/layout";
import { EV } from "../shared/protocol";
import { aim, create, dist, easelFace, near, remove as removeBoard, sendTo } from "./boards";
import { CFG } from "./config";
import { remove as removeDrawing, setHidden } from "./drawings";
import { adminGive, recipeOf } from "./materials";
import * as most from "./most";
import { activeSessions } from "./sessions";
import { boards, getDrawing, stats, type BoardRec } from "./store";

const say = (p: Player, t: string) => Chat.sendToPlayer(p, t);

function findPlayer(q: string | undefined): Player | null {
  if (!q) return null;
  const id = Number(q);
  if (Number.isInteger(id)) {
    const p = Player.getById(id);
    if (p) return p;
  }
  const l = q.toLowerCase();
  return Player.all().find((p) => p.nickname.toLowerCase() === l) ?? Player.all().find((p) => p.nickname.toLowerCase().includes(l)) ?? null;
}

const num = (v: unknown, def: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};

export async function buildBoard(p: Player, kind: "deska" | "stojan" | "kram", cols = 3, rows = 2, width = 1.5, height?: number): Promise<string> {
  const by = await most.charId(p);
  if (kind === "stojan") {
    const { face, yaw } = easelFace(p, width);
    const b = create("stojan", face, by, { yaw, model: CFG.stojan.model });
    return typeof b === "string" ? b : `Stojan ${b.id} stojí před tebou (list ${face.w} × ${face.h} m).`;
  }
  const a = await aim(p);
  if (kind === "kram") {
    const b = create("kram", { pos: a.pos, n: a.n, w: 1, h: 1, cols: 0, rows: 0 }, by);
    return typeof b === "string" ? b : `Krám písaře ${b.id} je tam, kam se díváš.`;
  }
  const face: Face = { pos: a.pos, n: a.n, w: width, h: height ?? faceHeight(width, cols, rows), cols, rows };
  const b = create("deska", face, by);
  if (typeof b === "string") return b;
  return `Vývěska ${b.id}: ${cols} × ${rows} listů, ${face.w} × ${face.h} m` + (a.hit ? " na povrchu, kam se díváš." : " (povrch nenalezen: visí 1,5 m před tebou).");
}

function boardInfo(b: BoardRec, from?: { x: number; y: number; z: number }): string {
  const used = b.slots.filter(Boolean).length;
  return `${b.kind} ${b.id}: ${used}/${b.slots.length} listů` + (from ? `, ${Math.round(dist(b, from))} m` : "");
}

export function info(): string {
  const st = stats();
  let drawings = 0;
  let hidden = 0;
  for (const b of boards.values()) for (const s of b.slots) if (s) (drawings++, s.hid && hidden++);
  return [
    `Kresby: ${st.boards} desek, ${drawings} vystavených kreseb (${hidden} zabavených), ${activeSessions()} se právě kreslí.`,
    `Úložiště: ${st.storage}, zápisů ${st.writes}, čeká ${st.pending}. Mezipaměť ${st.cached} kreseb / ${(st.cacheBytes / 1024).toFixed(0)} kB.`,
    `Napojení: ${most.mostInfo()}.`,
    `Svět: ${CFG.svet.rezim}, listů ve světě ${sheets.count()} (nepostavených ${sheets.stats.failed}), textur vykresleno ${assets.stats.rendered} za ${assets.stats.renderMs} ms, ${(assets.stats.bytes / 1048576).toFixed(1)} MB, přenačtení balíčků ${assets.stats.reloads}${assets.stats.lastError ? ", chyba: " + assets.stats.lastError : ""}.`,
  ].join("\n");
}

const HELP =
  "/kresby tabule [sloupce] [řádky] [šířka m] [výška m] | stojan [šířka m] | kram | smazat | dat <hráč> pergamen|papir|kniha|nastroje|sada [počet] | dat <hráč> inkoust <recept> | info | kdo | skryt <id> | obnovit <id> | vymazat <id> | ladit | nastaveni [cesta]";

export async function command(p: Player, args: string[]) {
  const [sub, ...rest] = args;
  const admin = () => most.can(p, "kresby.admin");
  const mod = () => most.can(p, "kresby.moderate");
  switch ((sub ?? "").toLowerCase()) {
    case "tabule":
    case "vyveska":
      if (!(await admin())) return say(p, "Na to nemáš právo.");
      return say(p, await buildBoard(p, "deska", num(rest[0], 3, 1, 8), num(rest[1], 2, 1, 6), num(rest[2], 1.5, 0.3, 6), rest[3] ? num(rest[3], 1, 0.2, 4) : undefined));
    case "stojan":
      if (!(await admin())) return say(p, "Na to nemáš právo.");
      return say(p, await buildBoard(p, "stojan", 1, 1, num(rest[0], CFG.stojan.width, 0.3, 2)));
    case "kram":
      if (!(await admin())) return say(p, "Na to nemáš právo.");
      return say(p, await buildBoard(p, "kram"));
    case "smazat": {
      if (!(await admin())) return say(p, "Na to nemáš právo.");
      const b = near(p.position, 5)[0];
      if (!b) return say(p, "Do 5 m žádná deska není.");
      removeBoard(b);
      return say(p, `Deska ${b.id} je pryč (vystavené kresby zůstaly v úložišti).`);
    }
    case "dat": {
      if (!(await admin())) return say(p, "Na to nemáš právo.");
      const t = findPlayer(rest[0]);
      if (!t) return say(p, "Takový hráč tu není. " + HELP);
      return say(p, await adminGive(t, (rest[1] ?? "").toLowerCase(), rest.slice(2).join(" ") || undefined));
    }
    case "info":
      return say(p, info());
    case "kdo": {
      const b = near(p.position, 6)[0];
      if (!b) return say(p, "Do 6 m žádná deska není.");
      const lines = b.slots.map((s, i) => `${i + 1}: ` + (s ? `„${s.t}“ #${s.d} ${s.a ? "– " + s.a : "(nepodepsáno)"}${s.hid ? " [zabaveno]" : ""}` : "prázdný"));
      const moderator = await mod();
      return say(p, boardInfo(b) + "\n" + lines.map((l, i) => (moderator || !b.slots[i]?.hid ? l : `${i + 1}: zabaveno`)).join("\n"));
    }
    case "skryt":
    case "obnovit":
    case "vymazat": {
      if (!(await mod())) return say(p, "Na to nemáš právo.");
      const id = Math.floor(Number(rest[0]));
      if (!id) return say(p, "Číslo kresby najdeš přes /kresby kdo.");
      const ok = sub === "vymazat" ? await removeDrawing(id) : await setHidden(id, sub === "skryt");
      return say(p, ok ? `Kresba ${id}: ${sub === "skryt" ? "zabavena" : sub === "obnovit" ? "vrácena" : "smazána"}.` : `Kresba ${id} neexistuje.`);
    }
    case "nastaveni":
    case "nastavení": {
      if (!(await admin())) return say(p, "Na to nemáš právo.");
      if (await settings.open(p, rest.join(" ") || undefined)) return;
      return say(p, "Editor nastavení je ve správě (F10). Správa neběží nebo editor nastavení nemá.");
    }
    case "ladit":
      if (!(await admin())) return say(p, "Na to nemáš právo.");
      sendTo(p, EV.ladit, { on: true, ms: 60000 });
      return say(p, "Obrysy desek a listů na 60 s.");
    default:
      return say(p, HELP);
  }
}

// ---------------------------------------------------------------------------
// panel pro sprava

const WHAT = ["pergamen", "papir", "kniha", "nastroje", "sada", "inkoust"].map((v) => ({ value: v, label: v }));

export function panels() {
  return [
    {
      id: "kresby",
      title: "Kresby",
      group: "Moduly",
      description: "Vystavené kresby, moderace, materiál a stavba vývěsek.",
      perm: "kresby.moderate",
      owner: "kresby",
      actions: [
        {
          id: "okoli",
          label: "Kresby poblíž",
          autorun: true,
          submit: "Obnovit",
          params: [{ name: "dosah", label: "Dosah (m)", type: "number", default: 60, min: 5, max: 2000 }],
          handler: ({ caller, params }: { caller: Player; params: Record<string, any> }) => {
            const rows: Record<string, string | number | boolean>[] = [];
            for (const b of near(caller.position, Number(params.dosah) || 60)) {
              b.slots.forEach((s, i) => {
                if (!s) return;
                rows.push({ _id: s.d, _skryta: !!s.hid, id: s.d, deska: `${b.kind} ${b.id}`, list: i + 1, nazev: s.t, autor: s.a || "(nepodepsáno)", stav: s.hid ? "zabavená" : "visí", m: Math.round(dist(b, caller.position)) });
              });
            }
            return {
              table: {
                columns: [{ key: "id", label: "Kresba", align: "right" }, { key: "deska", label: "Deska" }, { key: "list", label: "List", align: "right" }, { key: "nazev", label: "Název" }, { key: "autor", label: "Autor" }, { key: "stav", label: "Stav" }, { key: "m", label: "m", align: "right" }],
                rows,
                rowActions: [
                  { action: "skryt", label: "Zabavit", params: { id: "_id" }, whenNot: "_skryta" },
                  { action: "obnovit", label: "Vrátit", params: { id: "_id" }, when: "_skryta" },
                  { action: "smazat", label: "Smazat", params: { id: "_id" }, confirm: "Kresbu smazat natrvalo?", danger: true },
                ],
                empty: "Poblíž nic nevisí.",
              },
            };
          },
        },
        {
          id: "skryt",
          label: "Zabavit kresbu",
          params: [{ name: "id", label: "Číslo kresby", type: "number", integer: true, min: 1 }],
          handler: async ({ params }: { params: Record<string, any> }) => ((await setHidden(Number(params.id), true)) ? `Kresba ${params.id} zabavena.` : { ok: false, message: "Taková kresba není." }),
        },
        {
          id: "obnovit",
          label: "Vrátit zabavenou",
          params: [{ name: "id", label: "Číslo kresby", type: "number", integer: true, min: 1 }],
          handler: async ({ params }: { params: Record<string, any> }) => ((await setHidden(Number(params.id), false)) ? `Kresba ${params.id} vrácena.` : { ok: false, message: "Taková kresba není." }),
        },
        {
          id: "smazat",
          label: "Smazat kresbu",
          danger: true,
          confirm: "Kresbu smazat natrvalo?",
          params: [{ name: "id", label: "Číslo kresby", type: "number", integer: true, min: 1 }],
          handler: async ({ params }: { params: Record<string, any> }) => ((await removeDrawing(Number(params.id))) ? `Kresba ${params.id} smazána.` : { ok: false, message: "Taková kresba není." }),
        },
        {
          id: "nahled",
          label: "Prohlédnout kresbu",
          params: [{ name: "id", label: "Číslo kresby", type: "number", integer: true, min: 1 }],
          handler: async ({ caller, params }: { caller: Player; params: Record<string, any> }) => {
            const r = await getDrawing(Number(params.id));
            if (!r) return { ok: false, message: "Taková kresba není." };
            sendTo(caller, EV.prohlizet, { title: r.t, author: r.s ? r.a : "", h: r.h, d: r.d, paper: r.p });
            return { message: `„${r.t}“ od ${r.a} (${r.n} bodů)`, close: true };
          },
        },
        {
          id: "dat",
          label: "Dát materiál",
          perm: "kresby.admin",
          params: [
            { name: "player", label: "Hráč", type: "player", default: "me" },
            { name: "co", label: "Co", type: "select", options: WHAT, default: "sada" },
            { name: "arg", label: "Počet / recept", required: false, placeholder: "3 nebo modr" },
          ],
          handler: async ({ params }: { params: Record<string, any> }) => {
            if (params.co === "inkoust" && params.arg && !recipeOf(String(params.arg)) && !Number(params.arg)) return { ok: false, message: "Recepty: " + CFG.recipes.map((r) => r.id).join(", ") };
            return adminGive(params.player as Player, String(params.co), params.arg ? String(params.arg) : undefined);
          },
        },
        {
          id: "postavit",
          label: "Postavit vývěsku / stojan / krám",
          perm: "kresby.admin",
          params: [
            { name: "druh", label: "Co", type: "select", options: [{ value: "deska", label: "Vývěska (kam se dívám)" }, { value: "stojan", label: "Stojan (přede mnou)" }, { value: "kram", label: "Krám písaře (kam se dívám)" }], default: "deska" },
            { name: "sloupce", label: "Sloupce", type: "number", integer: true, default: 3, min: 1, max: 8 },
            { name: "radky", label: "Řádky", type: "number", integer: true, default: 2, min: 1, max: 6 },
            { name: "sirka", label: "Šířka (m)", type: "number", default: 1.5, min: 0.3, max: 6, step: 0.05 },
          ],
          handler: async ({ caller, params }: { caller: Player; params: Record<string, any> }) =>
            buildBoard(caller, params.druh, params.sloupce, params.radky, params.druh === "stojan" ? Math.min(2, params.sirka) : params.sirka),
        },
        {
          id: "desky",
          label: "Desky poblíž",
          perm: "kresby.admin",
          params: [{ name: "dosah", label: "Dosah (m)", type: "number", default: 100, min: 5, max: 5000 }],
          handler: ({ caller, params }: { caller: Player; params: Record<string, any> }) => ({
            table: {
              columns: [{ key: "id", label: "Deska", align: "right" }, { key: "druh", label: "Druh" }, { key: "listy", label: "Listy" }, { key: "m", label: "m", align: "right" }],
              rows: near(caller.position, Number(params.dosah) || 100).map((b) => ({ _id: b.id, id: b.id, druh: b.kind, listy: `${b.slots.filter(Boolean).length}/${b.slots.length}`, m: Math.round(dist(b, caller.position)) })),
              rowActions: [{ action: "smazatDesku", label: "Smazat", params: { id: "_id" }, confirm: "Desku smazat? Vystavené kresby zůstanou v úložišti.", danger: true }],
              empty: "Poblíž žádná deska není.",
            },
          }),
        },
        {
          id: "smazatDesku",
          label: "Smazat desku",
          perm: "kresby.admin",
          danger: true,
          params: [{ name: "id", label: "Číslo desky", type: "number", integer: true, min: 1 }],
          handler: ({ params }: { params: Record<string, any> }) => {
            const b = boards.get(Number(params.id));
            if (!b) return { ok: false, message: "Taková deska není." };
            removeBoard(b);
            return `Deska ${b.id} smazána.`;
          },
        },
        { id: "stav", label: "Stav modulu", autorun: false, handler: () => ({ text: info() }) },
      ],
    },
  ];
}
