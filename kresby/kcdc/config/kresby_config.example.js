// Nastavení kreseb pro server Kingdoms Connected. Načte se před server.js (manifest serverScripts).
// Build tenhle soubor jen založí a dál ho nepřepisuje - úpravy tady přežijí nové verze.
// Všechny volby a výchozí hodnoty: src/server/config.ts (DEFAULTS). Uvést stačí to, co měníte.
globalThis.KRESBY_CONFIG = {
  // Bez resource "most": přezdívky správců (stavba vývěsek, materiál, moderace). S mostem rozhoduje most.perms.has
  // ("kresby.admin", "kresby.moderate").
  admini: [],
  // Bez most.storage jsou vývěsky jen v paměti do restartu. Vlastní úložiště: { get, set, delete, keys } (klíče "kresby:…").
  // storage: null,
  // kdo smí strhnout list z vývěsky: "anyone" | "author" | "admin"
  tearDown: "anyone",
  // jedna uložená kresba za tolik ms na postavu
  cooldownMs: 60000,
  // krám písaře: "nativni" = obchod hry (groše hry), "menu" = nabídka placená přes most.economy
  kram: "nativni",
  // Kresby ve světě jako textura na listu (osvětlené, se stíny). Nové kresby žijí v resource kresby-obrazy-N, které
  // je po nové kresbě potřeba přenačíst: na playgroundu to kresby udělají samy, jinde doplňte hák (AGENTS.md, 2b):
  // svet: { reload: (novych, zmenenych) => { /* refresh + start <novych>, restart <zmenenych> v konzoli serveru */ } },
  // svet.konzole (výchozí true) má smysl jen na playgroundu gingy-kcdc (přenačtení přes jeho konzoli, hledá
  // logs/playground.pid). Na jiném serveru ho vypněte, přenačtení pak obstará jen hák svet.reload (nebo restart):
  // svet: { konzole: false },
  // Většinu nastavení jde měnit za běhu ve správě (F10 → Nastavení → Kresby, /kresby nastaveni).
  klient: {
    // kreslicí plátno: "auto" (Scaleform, když nejde, HTML), "nativni", "web"
    platno: "auto",
    // klávesa u vývěsky (musí být mezi ActionHint.keys(), jinak se použije Key.bind a infotext)
    useKey: "f",
    // rozpočet 3D čar (Gizmos: 16 384 úseků pro všechny resources, 128 kreseb na resource)
    gizmoUnits: 6000,
    gizmoIds: 96,
    drawRange: 14,
  },
};
