// Vzhled kreseb, který jde měnit v nastavení (správa): druhy papíru a efekty nástrojů. Sdílí server (rastr do textury)
// i klient (plátno, prohlížení, ladicí čáry). Server pošle aktuální hodnoty klientům v první zprávě okolí (cfg.vzhled).

export type RGB = [number, number, number];

/** druh listu; `kod` je trvalé číslo v datech kresby (0 pergamen, 1 papír, další z nastavení) */
export interface PaperDef {
  kod: number;
  id: string;
  name: string;
  rgb: RGB;
  styl: "pergamen" | "papir" | "hladky";
}

export interface ToolFx {
  pen: { taper: number; fade: number; blot: number; hardness: number };
  brush: { fade: number; wet: number; hardness: number };
  charcoal: { grain: number; hardness: number };
  scrape: { strength: number };
  gold: { glint: number };
}

export interface Look {
  papers: PaperDef[];
  fx: ToolFx;
  mix: "pigment" | "svetlo";
}

/** listy, které se neprodávají: jen pro desky jiných resource (server/api.ts), např. školní tabule pro křídu.
 *  Kód 31, aby se nepotkal s listy ze správy (ty berou kódy od 0). */
export const SYSTEM_PAPERS: PaperDef[] = [{ kod: 31, id: "tabule", name: "Tabule", rgb: [44, 50, 46], styl: "hladky" }];

export const DEFAULT_LOOK: Look = {
  papers: [
    { kod: 0, id: "pergamen", name: "Čistý pergamen", rgb: [232, 218, 188], styl: "pergamen" },
    { kod: 1, id: "papir", name: "Arch papíru", rgb: [241, 236, 222], styl: "papir" },
    SYSTEM_PAPERS[0],
  ],
  fx: {
    pen: { taper: 0.65, fade: 1600, blot: 0.14, hardness: 0.85 },
    brush: { fade: 2600, wet: 0.7, hardness: 0.25 },
    charcoal: { grain: 1, hardness: 0.55 },
    scrape: { strength: 1 },
    gold: { glint: 0.45 },
  },
  mix: "pigment",
};

export const LOOK: Look = JSON.parse(JSON.stringify(DEFAULT_LOOK));

/** list podle kódu (neznámý kód = první list) */
export const PAPERS: PaperDef[] = [];
function index() {
  PAPERS.length = 0;
  for (const p of LOOK.papers) if (p.kod >= 0 && p.kod < 32) PAPERS[p.kod] = p;
}
index();

export function paperOf(kod: number): PaperDef {
  return PAPERS[kod] ?? LOOK.papers[0] ?? DEFAULT_LOOK.papers[0];
}

export function setLook(over: Partial<Look>) {
  if (over.papers && over.papers.length) LOOK.papers = over.papers.map((p) => ({ ...p, rgb: [...p.rgb] as RGB }));
  if (over.fx) {
    const f = over.fx as Partial<ToolFx>;
    for (const k of Object.keys(LOOK.fx) as (keyof ToolFx)[]) if (f[k]) Object.assign(LOOK.fx[k], f[k]);
  }
  if (over.mix) LOOK.mix = over.mix;
  index();
}
