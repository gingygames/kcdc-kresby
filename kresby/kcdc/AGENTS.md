# Kresby (KCDC): podklady pro AI agenty, kteří modul nasazují na cizí server a framework

> Kingdoms Connected je hlavní platforma; verze pro KCD:MP (`../`) je zmrazená a nové věci se do ní nepřenášejí.

Čtěte nejdřív [README.md](README.md) (co modul dělá, příkazy, co ověřit ve hře). Tady jsou integrační body, co přemapovat, jak testovat a známá omezení KCDC 1.7.2. Kontrakt mostu: [../../most/CONTRACT.md](../../most/CONTRACT.md) (typy v `most/src/shared/contract.ts`), správa: [../../sprava/AGENTS.md](../../sprava/AGENTS.md).

## 1. Jak modul visí na okolí

```
klient kresby ── události kresby:* (src/shared/protocol.ts) ── server kresby ──► most (Exports.get("most","api"))
     │                                                              │            └─ bez mostu: shim most/shim/most.ts
     └─ setUi(...) – vlastní UI frameworku                            └─► sprava (export spravaPanels / registerPanel)
```

- **Všechno, co závisí na frameworku, je v `src/server/most.ts`.** Ostatní soubory volají jen jeho funkce. Napojení se čte při každém volání přes shim mostu (`most/shim/most.ts`, esbuild ho přibalí), po restartu mostu se tedy použije nový objekt.
- Manifest: `resourceDependencies: [{ name: "most", optional: true }]`. **Na `sprava` závislost nedávejte**: Správa si panel stáhne sama z exportu `spravaPanels`. Cyklus závislostí umí KCDC 1.7.1 za běhu shodit (přetečení zásobníku při `restart`).
- Resource se musí jmenovat `kresby`: HTML záloha je na `fw://resources/kresby/ui/platno.html` a klíče úložiště začínají `kresby:`.

## 2. Co modul od mostu chce (a co dělá bez něj)

| Funkce mostu | Použití v kresbách | Bez mostu / když funkce chybí |
|---|---|---|
| `identity.getCharacterId(pid)` | autor kresby (`u`), pauza mezi kresbami, kdo smí strhnout list (`tearDown: "author"`) | `KRESBY_CONFIG.identity`, jinak shim: `steam:<id>`, jinak `nick:<přezdívka malými>` (stejně jako standalone most) |
| `identity.getName(pid)` | podpis na kresbě | přezdívka |
| `perms.has(pid, perm)` | `kresby.admin` (stavba, materiál, krám) nebo obecné `admin`; `kresby.moderate` nebo `kresby.admin` nebo `admin` (zabavit / smazat) | `KRESBY_CONFIG.isAdmin(p)` / `admini` (přezdívky) |
| `storage.get/set/delete/keys` | `kresby:meta`, `kresby:deska/<id>`, `kresby:kresba/<id>` (JSON, jedna hodnota < 20 kB, limit mostu 1 MB) | `KRESBY_CONFIG.storage` (stejné názvy), jinak shim: soubor `<server>/data/most-shim/kresby.json` |
| `inventory.count/has/give/take` | **jen obyčejné herní předměty**: brky, štětce, uhel, lahvička, voda, suroviny receptů, herní inkoust z kořisti | `Inventory` KCDC |
| `inventory.registerCustomItem(def)` | 16 vlastních typů (`kresby:pergamen`, `papir`, `kniha`, `kresba`, `inkoust`, `inkoust:<recept>`) | shim; GUID se pak přečte identickým `Items.register` (viz 4.) |
| `ui.menu(pid, spec)` | všechny nabídky (deska, dokončení, kniha, krám v režimu menu) | herní dialog, stránkovaný po 6 volbách (`#dalsi` / `#zpet`) |
| `notify(pid, text, kind)` | hlášení | notifikace hry v klientu (`kresby:info` → `Hud.showNotification`) |
| `economy.remove(charId, n, měna, důvod)` | jen `kram: "menu"` | groše hry |

Každé volání mostu je v `try`. Výjimka nebo nečekaná návratová hodnota znamená, že se pro to jedno volání použije nativní záloha a do logu se zapíše `most.<část>: …`.

## 2b. Kresby ve světě: textury jako streamované assety (nejdůležitější integrační bod)

KCDC nemá texturu ze skriptu za běhu. Kresby to obcházejí přes streamování assetů (docs KCDC „Custom assets“):

1. Pověšená kresba se na serveru vykreslí (`src/server/raster.ts`, všechny efekty; rastr, převzorkování, mipmapy i BC1 po kouscích, nejvýš `svet.rozpocetMs` na krok) a uloží do **samostatného resource bez skriptů** `kresby-obrazy-<n>` ve složce resources serveru: textura `stream/textures/kcdc/<n>/k<id>.dds(.1–.4)` (BC1 sRGB, mipmapy rozdělené jako textury hry, `src/server/dds.ts`), model listu `stream/objects/kcdc/<n>/k<id>.cgf + .cgfm` a materiál `.mtl` (`src/server/cgf.ts`). Balíček 0 = čisté listy všech druhů papíru.
   - **Horké a studené balíčky (od 1. 11. 2026):** přenačtený balíček stáhne znovu každý připojený hráč. Nové kresby za běhu proto jdou do malého horkého balíčku (`svet.horky`, výchozí 3 kresby ≈ 1 MB), přenačítá se jen ten. Studené balíčky (`svet.shard`, 24) se za běhu nemění: smazaná kresba nechá díru a balíček se nepřenačte. Při startu kreseb **bez připojených hráčů a s funkčním přenačtením** se kresby z horkých balíčků přesunou do děr a nových studených balíčků (textura přejmenováním, model a materiál znovu) a přenačtou se. Chybějící textury při startu jdou rovnou do studených (jen když nikdo není připojený). Bez háku ani konzole se nepřelévá a horké balíčky mají plnou velikost `svet.shard`.
   - Stav balíčků (`hot`) je v `kresby:obrazy`; zápis se slučuje s ostatními (`CFG.saveMs`).
2. Balíček se musí **přenačíst** (`start` u nového po `refresh`, `restart` u změněného). Skript resource to sám neumí, proto hák v tomto pořadí:
   - `KRESBY_CONFIG.svet.reload(novych: string[], zmenenych: string[])` – **na cizím serveru doplňte** (RCON, txAdmin, vlastní konzole, cokoli, co pošle příkazy do konzole KCDC). Na restart závislých resource pozor: balíčky nemají závislosti a nikdo na nich nezávisí.
   - konzole playgroundu (`logs/playground.pid` → TCP 127.0.0.1:<consolePort>, `{"lines":[…]}`), vypnout `svet.konzole = false`,
   - nic: textury se ukážou po restartu serveru (server zabalí balíčky při startu), do té doby visí čistý list. Log napíše příkazy, které je třeba spustit.
3. Po `resourceStart` balíčku (a ~1,5 s, KCDC balí assety až po startu skriptů) server postaví / vymění list jako `Prop` s modelem kresby (`src/server/props.ts`, `physics: "none"`, měřítko podle listu) a pošle `EV.deska` jen deskám s kresbou, která právě přestala čekat. Co se nepostaví, zkouší znovu po 3 s.
   - **Generace přenačtení:** každý zápis do balíčku zvýší jeho generaci a odeslané přenačtení si ji zapamatuje. Kresba zapsaná až po odeslání restartu po `resourceStart` dál čeká (`pend`) a balíček se přenačte znovu. Když `resourceStart` po odeslání nepřijde (hák selhal potichu), balíček se po `max(60 s, 2 × reloadMs)` pošle znovu, odstup se při dalších nezdarech zdvojnásobuje (nejvýš 16×). Na cizím serveru tedy hák nemusí hlásit úspěch, stačí, aby balíček opravdu restartoval.
4. Režim `svet.rezim`: `textura` (výchozí), `cary` (staré ladicí 3D čáry Gizmos, svítí), `oboji`. Bez `require("fs")` v serverovém skriptu (jiný hosting) se textury vypnou a zůstane `cary`.

Stav (co je u klientů, co čeká) je v `most.storage` pod `kresby:obrazy`. Diagnostika: konzole `kresby info`, ve hře `/kresby info`.

## 3. Co přemapovat na cizím serveru (`kresby_config.js`)

Výchozí hodnoty a všechny klíče najdete v `src/server/config.ts` (`DEFAULTS`). Build soubor `kresby_config.js` jen založí a dál ho nepřepisuje.

| Klíč | Kdy měnit |
|---|---|
| `materials.*Visual` | vzhled vlastních předmětů. **Musí to být drobnost (MiscItem), materiál nebo dokument hry**, jinak `Items.register` selže (zkouší se náhradní vzhledy dokumentů). |
| `materials.quillItem / brushItem / charcoalItem / vialItem / waterItems / nativeInk` | když framework přejmenoval nebo nahradil herní předměty |
| `recipes[].needs`, `ingredientNames` | suroviny receptů (jména z herních tabulek, jak je bere `most.inventory.count`) |
| `shop`, `kram` | ceny; `"nativni"` = obchod hry v groších, `"menu"` = nabídka placená `most.economy.remove` (vlastní měna frameworku) |
| `tearDown`, `cooldownMs`, `maxPoints`, `maxStrokes`, `itemDataMax` | pravidla serveru |
| `stojan.model / up / forward / tilt / yaw` | jiný model stojanu nebo poloha líce |
| `svet.*` | textury ve světě: `rezim`, `sirka` (512/1024/2048; 512 × 256 ≈ 90 kB místo ~350 kB na kresbu, ostrost ve hře zatím neověřená, proto výchozí 1024), `kvalita`, `shard` (studený balíček), `horky` (horký balíček, viz 2b), `reloadMs`, `reload` (hák, viz 2b), `konzole`, `slozka` (resources serveru), `predpona` (`kresby-obrazy`), `lesk`, `odsazeni`, `rozpocetMs` |
| `papiry`, `nastroje`, `michani`, `velikost`, `moderace` | druhy listů (kód 0–31 je trvalý v datech kreseb), nástroje (předmět, zapnuto), míchání a ředění, rozsah stopy, zakázaná slova a kvóta vystavených |
| `klient.useKey` | klávesa u desky (musí být v `ActionHint.keys()`, jinak klient použije `Key.bind` a infotext) |
| `klient.gizmoUnits / gizmoIds` | podíl kreseb na sdíleném rozpočtu Gizmos (16 384 úseků pro všechny resources, 128 kreseb na resource) |
| `klient.platno` | `"auto"` / `"nativni"` / `"web"` |

## 4. Vlastní předměty a inventář frameworku

- Kresba a lahvička jsou **vlastní typy** (`Items.register`) s daty v `metadata.custom.data`. Data jsou jen na serveru, limit je 16 KiB JSON. Kresby čtou a mění tyto řádky **nativně** (`Inventory.get`, `Inventory.add` s `metadata.custom`, `Inventory.updateCustom`, `Inventory.remove` podle id řádku), protože kontrakt mostu řádky s vlastním názvem a popisem neumí (`give` nese jen `data`). Pokud framework drží inventář mimo KCDC, adaptér musí tyhle čtyři operace zrcadlit, nebo do mostu přidat rozšíření (`inventory.list` už existuje, chybí úprava řádku). Funkce v `most.ts`: `rows`, `customData`, `customName`, `giveCustom`, `takeRow`, `updateRow`.
- **Texty předmětů musí být na jeden řádek.** KCDC 1.7.1 odmítne `\n` (a další řídicí znaky) v názvu i popisu s chybou „Invalid custom item text“ (ověřeno na playgroundu 26. 10.). U vlastního textu kusu vrací `invalidMetadata`. `metadata.custom` na nativní třídě server odmítne vždy.
- Registrace: typ registruje most (`inventory.registerCustomItem`, si typy pamatuje v `custom-items.json`), kresby si GUID přečtou `Items.register` se **stejnou** definicí („Identical repeats succeed“). Když běžící most registraci nemá, je `Items.register` v kresbách jediná registrace.
- Framework musí ukládat inventář i s `metadata` (kresby v brašnách, kapky v lahvičkách). Malá kresba (do `itemDataMax` znaků, běžně ~12 000 bodů) nese data sama. Větší je v úložišti a předmět nese odkaz `{ id, h }`.

## 4b. Nastavení ve správě

`src/server/settings.ts` zaregistruje editor (`Exports.get("sprava","registerSettings")(def, "kresby")` + export `spravaSettings`). Uložené v `most.storage` `kresby:nastaveni`, při startu se použijí před registrací předmětů. Nový inkoust / druh listu se zaregistruje za běhu; změna definice už registrovaného předmětu (název typu, váha, vzhled) platí po restartu serveru (KCDC registrace nemění). Hodnoty kreseb zobrazené hráčům (název a popis lahvičky) nesou data kusu, takže změna názvu receptu se projeví hned u nových lahviček. Vývěsky v editoru: „Kde stojí divák“ (pozice + směr pohledu) + vzdálenost + výška + sklon; z toho se počítá střed a normála desky (`valueToFace`). Test, že schéma i hodnota projdou ověřením správy: `test/settings.test.ts` (importuje `sprava/src/settings-core.ts`).

## 5. Vlastní UI (klient)

Kreslicí plátno a prohlížení jsou vyměnitelné backendy (`src/client/hooks.ts`):
```ts
const setUi = Exports.get("kresby", "setUi") as (ui: { canvas?: CanvasBackend | null; viewer?: ViewerBackend | null }) => void;
setUi({ canvas: { open(api) { …; return true; }, close() { … }, hide() { … } } });
```
- `CanvasApi` (`api`) drží pravidla. Backend jen kreslí a sbírá vstup: `api.addStroke(p)` (x, y, přítlak po trojicích v logických px 768 × 512) vrátí `null` nebo důvod, proč tah neprošel. Dál `api.undo()`, `api.redo()` / `api.canRedo()`, `api.saveState()` (nepotvrzené tahy, ukládá se), `api.finish(název)`, `api.cancel()`, `api.drops()`, `api.charcoal()`, `api.drawing()`, `api.brush` (nástroj, inkoust a/b, poměr, velikost ve čtvrtpixelech, krytí) a `api.onChange(cb)` pro potvrzení, odmítnutí a zpět.
- Pořadí backendů: vlastní, nativní Scaleform (`native.ts`, se zkouškou kreslicího API a `_xmouse`), HTML (`web.ts`). `open()` vrací `false`, když backend neumí, a pak se zkusí další.
- Nabídky na serveru jdou přes `most.ui.menu`, takže když je framework převezme, převezme i nabídky kreseb.
- Kresby ve světě (`world.ts`, Gizmos) se nevyměňují. Rozpočet určuje `klient.gizmo*`.

Zamčené inkousty (recepty, které hráč nemá) jsou v `api.msg.locked` (`name`, `rgb`, `where` = kde je sehnat).

## 5b. Velké zprávy

Všechny zprávy jdou přes `src/server/net.ts` (`sendTo`, `onClient`) a `src/client/net.ts` (`listen`, `emitServer`). Když běží `most` s exportem `net` (most/CONTRACT.md, „Velké zprávy – export `net`“), jdou přes něj s `owner: "kresby"` a zpráva nad 12 000 znaků se pošle po částech (`most:part`). Bez mostu kresby dělí samy (`kresby:part`, stejný formát `{k,e,i,n,d}`). Malé zprávy se poslouchají vždy přímo (`Events.on` / `Events.onClient`), od mostu kresby berou jen zprávy složené z částí (`net.on(ev, f, "kresby", { direct: false })`), takže nic nepřijde dvakrát; po restartu mostu se posluchači zaregistrují znovu. KCDC zprávu nad ~64 KB usekne; velké jsou hlavně `data`, `prohlizet`, `platno` s `resume`, první `zive`, `okoli` a od klienta `tahy`.

## 6. Exporty pro ostatní resources

| Export | Strana | Co |
|---|---|---|
| `isBusy(playerId)` | server | hráč právě kreslí (loutna, hospoda a podobné moduly ho nemají rušit) |
| `giveMaterial(playerId, co, arg?)` | server | jako `/kresby dat` (`pergamen`, `papir`, `kniha`, `nastroje`, `sada`, `inkoust <recept>`), např. pro startovní výbavu |
| `spravaPanels()` | server | panel `kresby` pro Správu (akce `okoli`, `skryt`, `obnovit`, `smazat`, `nahled`, `dat`, `postavit`, `desky`, `smazatDesku`, `stav`) |
| `setUi(ui)`, `isDrawing()`, `stats()` | klient | vlastní UI, kreslí hráč?, čísla vykreslení (úseky, kreseb Gizmos, listy) |

## 7. Jak testovat

```sh
cd kresby/kcdc && npm install && npm test        # build + 61 testů, ~1 min
npm run perf                                     # jen výkonové testy s čísly
powershell -ExecutionPolicy Bypass -File playground\nasadit.ps1 -Jen kresby   # playground: jednou, pak log
```
- `test/fake.ts` je falešné API KCDC (server, klienti, Scaleform clip s kreslicím API, Gizmos s rozpočtem a limity, Inventory po řádcích s limitem 16 KiB a odmítáním `\n`, Dialogue, Vendor, Exports/Imports). Funkce `world()` propojí server a klienty přes JSON jako ve hře.
- Adaptér frameworku vyzkoušejte tak, že do `makeServer({ most: { api: vášMost } })` dáte vlastní objekt mostu (viz test „most: identita, práva…“ v `test/server.test.ts`) a pustíte testy.
- `test/sync.test.ts` celý tok od nápovědy akce po restart serveru, `test/server.test.ts` materiál, limity, perzistence, most, sprava, moderace, `test/balicky.test.ts` horké a studené balíčky, přelévání při startu, zprávy po přenačtení a generace / opakování přenačtení, `test/perf.test.ts` výkon (čísla v README: server, klient v režimu čar, cizí živé kreslení, pečení po kouscích, zpět na nativním plátně), `test/codec.test.ts` kodek + kompatibilita k2 s KCD:MP (`tools/lua_k2.py`, potřebuje `pip install lupa`).
- Na playgroundu ověřte v `server/logs/playground.log`: `[kresby] běží: most …, úložiště most`, `[sprava] panely modulu kresby: kresby` a žádné `Invalid custom item text`.

## 8. Co KCDC 1.7.2 neumí (a jak to modul obchází)

- **Dynamická textura / obrázek ve světě z dat za běhu neexistuje.** Od 27. 10. to modul obchází streamovanými assety (oddíl 2b): cena je přenačtení balíčku (prodleva ~30 s, stažení ~8 MB) a potřeba háku pro konzoli. `Items.register` umí v 1.7.2 vlastní `model`/`material`/`icon` (ikona jako base64 PNG, i za běhu), ale materiál musí být streamovaný soubor, takže to cestu nezkracuje. Původní řešení čarami (dále) zůstalo jako ladicí režim.
- Původní řešení: `Book.image`, `BookOptions.texture` a streamované `.cgf` berou jen soubory, které resource dodá při nasazení. `Web.setViewOffscreen` zmiňuje „render target na geometrii“, API pro to ale není. Kresba ve světě je proto z čar `Gizmos`: jedna barva a šířka (0,5–8 px obrazovky) na kresbu Gizmos, 128 kreseb na resource, 16 384 úseků pro všechny resources, bez zápisu hloubky. Modul seskupuje tahy podle barvy, krytí a šířky v px, slučuje malé skupiny, spojky mezi tahy vede za líc desky a LOD řídí podle velikosti listu na obrazovce.
- Klient neumí vyjmenovat entity ani props v dosahu, proto má server vlastní mřížku zájmu (32 m, `streamRange`).
- Scaleform `invoke` přenáší jen skaláry (žádný `beginGradientFill` ani bitmapy) a nemá událost pohybu myši. Modul čte `_xmouse/_ymouse` po 16 ms (v dokumentaci není, ověřuje se zkouškou) a nemá pravé tlačítko myši (Zpět je tlačítko). Režim prolínání `multiply` (průhledné inkousty) je jen v HTML záloze, nativně se použije krytí.
- Úrovňové vývěsky ani smart objekty hry server nevystavuje: vývěsku umístí správce pohledem (`World.raycast` přes jeho klienta).
- Data vlastního předmětu jsou omezená na 16 KiB a texty předmětů na jeden řádek.
