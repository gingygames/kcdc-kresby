// Události mezi serverem a klientem kreseb (KCDC). Server -> klient: player.emit (JSON řetězec),
// klient -> server: Events.emitServer. Všechny s předponou resource.

import type { V3 } from "./layout";

export const EV = {
  // server -> klient
  okoli: "kresby:okoli", // OkoliMsg: vývěsky, stojany a krámy, které přišly do dosahu / zmizely
  deska: "kresby:deska", // BoardMsg: změna jedné desky (pověšený / stržený list, kreslí se)
  data: "kresby:data", // DataMsg: obsah kresby na vyžádání (podle otisku)
  platno: "kresby:platno", // CanvasMsg: otevři kreslení
  ack: "kresby:ack", // AckMsg: potvrzení dávky tahů
  zavrit: "kresby:zavrit", // { s, why? }: kreslení skončilo
  zive: "kresby:zive", // LiveMsg: cizí kreslení naživo (divákům v dosahu)
  prohlizet: "kresby:prohlizet", // ViewMsg: prohlédnout kresbu (z brašny nebo z desky)
  kniha: "kresby:kniha", // { pages }: kniha o barvách v rukou (nativní Book)
  ladit: "kresby:ladit", // { on }: obrysy desek a listů (Gizmos)
  info: "kresby:info", // { text, kind }: oznámení hry (když chybí most.notify)
  // klient -> server
  chci: "kresby:chci", // { h: string[] } - pošli mi kresby
  pouzit: "kresby:pouzit", // { b, slot } - hráč použil desku (klávesa / nápověda akce)
  tahy: "kresby:tahy", // StrokesMsg
  zpet: "kresby:zpet", // { s, n } - vezmi zpět n posledních tahů
  hotovo: "kresby:hotovo", // { s, title } - dokončit (dál dialog: nechat viset / vzít)
  konec: "kresby:konec", // { s } - přestat kreslit bez uložení
  platnoChyba: "kresby:platnoChyba", // { s, why } - klient kreslení otevřít neumí
} as const;

export type BoardKind = "deska" | "stojan" | "kram";

export interface SlotMsg {
  h?: string; // otisk kresby (klíč mezipaměti a EV.chci)
  t?: string; // název
  a?: string; // podpis (jen podepsané)
  live?: number; // právě se na něj kreslí (id relace)
  paper: number;
  o?: string; // balíček s texturou kresby (klienti ji mají): textures/kcdc/<o>/k<id>.dds, models objects/kcdc/<o>/k<id>.cgf
  d?: number; // id kresby (s `o` = jméno souborů textury)
  pend?: 1; // textura kresby se peče / balíček se přenačítá: klient ji zatím ukazuje čarami
}

export interface BoardMsg {
  id: number;
  kind: BoardKind;
  pos: V3;
  n: V3;
  w: number;
  h: number;
  cols: number;
  rows: number;
  slots: (SlotMsg | null)[];
  rev: number;
  own?: 1; // deska jiného resource (škola): nápověda akce kreseb se u ní neukazuje
}

export interface OkoliMsg {
  add: BoardMsg[];
  del: number[];
}

export interface DataMsg {
  h: string;
  d: string | null; // "k3." / "k2.", null = neznámá nebo zabavená
  retry?: boolean; // server teď posílá moc dat: zeptej se znovu později
}

export interface CanvasInk {
  name: string;
  rgb: [number, number, number];
  flags: number;
  strength: number;
  drops: number; // kolik kapek smí kresba spotřebovat
  pick?: false; // jen pro předlohu (volná relace): na plátně se nedá vybrat
}

export interface LockedInk {
  name: string;
  rgb: [number, number, number];
  flags: number;
  where: string; // "U písaře za 4 groše" / "Namíchej: …"
}

export interface CanvasMsg {
  s: number; // relace
  b: number;
  slot: number;
  paper: number;
  tools: number[]; // povolené nástroje (0 brk, 1 štětec, 2 uhel, 3 škrabka)
  inks: CanvasInk[];
  locked?: LockedInk[]; // inkousty, které hráč nemá (na plátně zamčené, s tím, kde je sehnat)
  charcoal: number; // kusů uhlu
  limits: { points: number; strokes: number; dropArea: number; charcoalArea: number; batch: number; batchPoints: number; sizeMin?: number; sizeMax?: number };
  title: string; // navržený název
  unlimited?: true; // volná relace jiného resource (škola): materiál neplatí, plátno neukazuje kapky
  resume?: string; // "k3." tahy, které už server přijal (návrat z dialogu dokončení / znovu otevřené plátno)
  seq?: number; // poslední přijatá dávka
  // kam s kamerou: list ve světě (klient z toho spočítá záběr i obdélník plátna na obrazovce)
  sheet: { pos: [number, number, number]; n: [number, number, number]; w: number; h: number; cx: number; cy: number; sw: number; sh: number };
}

export interface StrokesMsg {
  s: number;
  seq: number; // pořadí dávky (od 1)
  d: string; // "k3." kresba s prázdnými inkousty: tahy, inkousty a/b = index do CanvasMsg.inks od 1
}

export interface AckMsg {
  s: number;
  seq: number;
  ok: number; // přijatých tahů z dávky
  rej: number[]; // indexy odmítnutých tahů v dávce
  drops: number[]; // zbývá kapek po inkoustech
  charcoal: number; // zbývá px² uhlu
  why?: string;
}

export interface LiveMsg {
  b: number;
  slot: number;
  s: number;
  paper?: number;
  inks?: { rgb: [number, number, number]; flags: number; strength: number }[]; // jen v první zprávě relace
  add?: string; // "k3." nové tahy (inkousty z první zprávy)
  undo?: number;
  end?: boolean;
}

export interface ViewMsg {
  title: string;
  author: string; // prázdné = nepodepsáno
  h: string;
  d: string;
  paper: number;
  board?: number; // čte se na desce: kamera na list
  slot?: number;
  o?: string; // balíček s texturou (klient ji má, když Assets.has)
  id?: number;
  inv?: boolean; // čte se z brašny (klient zavře inventář)
  loading?: boolean; // jen v klientu: kresba ve světě se ještě načítá, prohlížeč to řekne
}

export const LIMITS = {
  dataBatch: 8, // otisků v jedné žádosti EV.chci
  titleLen: 48,
};
