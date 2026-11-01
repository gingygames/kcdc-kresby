# ui-kit: sdílený vzhled webových částí modulů

Jedna sada barev, písma, mezer a malých komponent pro všechno, co hra ukazuje jako web view: panel F10 a editor nastavení (`sprava/`), konzoli `;`, obrazovku tvorby postavy (`prichod/`), kreslicí plátno (`kresby/`), případně web části loutny a hospody. Cíl: aby moduly vypadaly jako jedna hra, byly čitelné a chovaly se stejně.

Vzhled je dobový, ale hlavně čitelný: **inkoust** (tmavé plochy), **pergamen** (světlý text a světlé „papírové“ plochy), **zlatý akcent**. Nic tu není průhledné natolik, aby text plaval nad scénou hry.

## Obsah
| Soubor | K čemu |
|---|---|
| `theme.css` | tokeny `--k-*`: barvy, písmo, mezery, tvar, stíny, přechody (150–200 ms), měřítko písma |
| `components.css` | komponenty: tlačítko, pole, přepínač, posuvník, karta, papír, drobečky, záložky, čip, odznak, klávesa, toast, potvrzovací okno, načítání, prázdný stav |
| `kit.js` | `window.Kit`: `init`, `toast`, `confirm`, `keys`, `store`, `nearest`, `scaleFor`, `el`, `trap` (ES5, bez závislostí) |
| `copy.mjs` | `copyKit(dest, opts)`: kopie sady do výstupu modulu při buildu |
| `check.mjs` | kontrola kontrastů barev (`node ui-kit/check.mjs`) |
| `test.mjs` | testy (`node --test ui-kit/test.mjs`) |
| `demo.html` | ukázka všech komponent (`python -m http.server` v kořeni repa, `/ui-kit/demo.html`) |

## Jak sadu použít v modulu
Stejný princip jako u `most/shim`: modul si sadu bere z repa relativní cestou a **zkopíruje ji při buildu** do svého výstupu. Nic se nestahuje ani nesdílí za běhu (web view hry čte jen soubory z vlastního resource).

1. V `tools/build.mjs` modulu (cesta podle hloubky; `sprava/tools/build.mjs` → `../../ui-kit/copy.mjs`, `loutna/kcdc/tools/build.mjs` → `../../../ui-kit/copy.mjs`):
   ```js
   import { copyKit } from "../../ui-kit/copy.mjs";
   copyKit(join(dist, "ui", "kit"));                  // theme.css, components.css, kit.js
   copyKit(join(dist, "ui", "kit"), { js: false });   // jen CSS
   ```
2. V manifestu resource musí `files` pokrývat výstup (`"files": ["ui/**"]` ho už zahrnuje).
3. V HTML před vlastní styly:
   ```html
   <link rel="stylesheet" href="kit/theme.css">
   <link rel="stylesheet" href="kit/components.css">
   <link rel="stylesheet" href="style.css">      <!-- jen to, co je specifické pro modul -->
   <script src="kit/kit.js"></script>
   <script>Kit.init();</script>                    <!-- nastaví měřítko písma podle výšky okna hry -->
   ```
4. `<body class="k">` (nebo prvek `.k-root`) nastaví pozadí, barvu a písmo. Dál používej třídy `k-*` a tokeny `var(--k-…)`; vlastní CSS modulu nemá přepisovat barvy natvrdo.

Náhled stránky bez hry: `tools/ui-dev` modulu (příklad `sprava/tools/ui-dev/`). Kopie sady v `dist/` se nikdy needituje, upravuje se jen `ui-kit/`.

## Tooltipy a výběry: nepoužívej nativní `title` ani rozbalovací seznam prohlížeče
Hra vykresluje web view bez okna (CEF offscreen), takže **nativní tooltip (`title`) a rozbalovací seznam `<select>` se neukážou a zůstane černý čtvereček**. Proto každá stránka volá `Kit.init()` (nebo aspoň `Kit.enhance()`); psát můžeš dál `title="…"` i `<select>`, kit je za běhu převede. Nový kód radši rovnou píše `data-tip="…"`.
- **Tooltip zrušíš** `title = ""`, `removeAttribute("title")` (sada kvůli tomu obaluje `Element.prototype.removeAttribute`: u prvku, jehož `data-tip` vznikl z `title`, ho odebere) nebo `removeAttribute("data-tip")`.
- **Select dál ovládej jako select:** `value`, `selectedIndex`, `disabled`, `hidden`, `style.display = "none"`, třídy a `data-tip` se promítnou do tlačítka `k-select`; `option.selected = true` a `form.reset()` se projeví při otevření, fokusu a po resetu formuláře. Nativní select je skrytý třídou `k-select-native` (`display: none !important`), nikdy ho neukazuj přes `style.display`. `<label for>` zaostří tlačítko. Odebraný select sada uvolní (observer, posluchače), po vrácení do stránky ho vylepší znovu. Plná šířka: podle změřené šířky, ve skrytém rodiči podle CSS šířky (`100%`); `.k-field` a `.k-input` jsou vždy na plnou šířku. Chybový stav: `.k-field.is-error .k-select` (vlastní styly modulu potřebují pravidlo i pro `.k-select`, ne jen `select`).

## Pravidla vzhledu
- **Kontrast:** text aspoň **4,5:1**, ovládací prvky a okraje polí aspoň 3:1. `node ui-kit/check.mjs` to hlídá pro všechny dvojice z `theme.css`; nová barva = nová dvojice v `PAIRS`. `--k-faint` je jen dekorace a vypnuté prvky, ne text.
- **Písmo:** rozměry v `rem` (nikdy v pevných `px` pro text), základ `15px × --k-scale`. `Kit.init()` nastaví `--k-scale` podle výšky okna (1080 px = 1, 4K = 1,8, nejméně 0,9). Nadpisy serifové (`--k-font-serif`), text bezpatkový.
- **Pozadí:** neprůhledné (`--k-bg`, `--k-surface`). Průhlednost jen u `--k-scrim` za modálním oknem.
- **Pohyb:** přechody 150 ms (`--k-t-fast`) pro hover a fokus, 200 ms (`--k-t`) pro otevření, zavření a toasty; vždy `--k-ease`. Respektuje `prefers-reduced-motion`. Okno se zobrazí třídou `.is-in` na `.k-window`, bez bliknutí.
- **Fokus:** každý ovladatelný prvek má viditelný fokus (`--k-focus`), jde ovládat klávesnicí (Tab, šipky, Enter, Esc).
- **Tlačítka:** jedno hlavní (zlaté) na místo, ostatní `--ghost`; nebezpečná akce `--danger` a vždy potvrzení, které říká, **co se stane** (`Kit.confirm({ title, text, ok, danger: true })`), ne „Opravdu?“.
- **Chyby:** řekni, co se stalo a co s tím (`Kit.toast(text, "err", { hint })`); u polí chybová zpráva pod polem (`.k-field.is-error .k-help`).
- **Nápověda kláves:** každé okno ukáže své klávesy (`Kit.keys(node, [["Esc", "zavřít"], …])`).
- **Texty ze serveru** (jména hráčů, výsledky modulů) se do stránky vkládají jen jako `textContent`, nikdy jako HTML; `Kit.el` to dělá samo.
- **Papír** (`.k-paper`) je pro dlouhé čtení a hru (tvorba postavy, listiny); nástroje (F10, konzole) zůstávají na inkoustu.

## API `Kit` (kit.js)
| Volání | Co dělá |
|---|---|
| `Kit.init()` | nastaví `--k-scale` podle výšky okna a hlídá změnu velikosti |
| `Kit.toast(text, kind?, { hint?, ms? })` | oznámení (`info` \| `ok` \| `warn` \| `err`), mizí samo (chyba 9 s, jinak 4 s), klik zavře; vrací funkci pro zavření |
| `Kit.confirm({ title, text, ok?, cancel?, danger? })` | `Promise<boolean>`; Esc a klik mimo = zrušit; u `danger` je zaostřené „Zrušit“ a Enter nepotvrdí |
| `Kit.keys(node, [[kombinace, popis], …])` | vykreslí řádek nápovědy kláves |
| `Kit.store(jmeno)` | `{ get(key, výchozí), set(key, hodnota), del(key) }`, JSON v `localStorage` s předponou; bez úložiště jen v paměti |
| `Kit.nearest(slovo, jména)` | nejbližší jméno pro „myslel jsi …?“ nebo `null` |
| `Kit.scaleFor(výška)` | násobek písma pro výšku okna |
| `Kit.el(tag, props, …děti)` | vytvoří prvek (`class`, `text`, `onclick`…), texty jen jako `textContent` |
| `Kit.window(node, { handle, key, min, size })` | přesouvatelné a zvětšitelné okno: stránka (web view) pokrývá celou obrazovku, okno je v ní `position: fixed`; posun za `handle`, úchyty na okrajích a v rozích (`k-rs`), dvojklik na `handle` = výchozí poloha; pozice a velikost v `Kit.store("window")`, po obnovení ohlídané proti obrazovce. Vrací `{ reset, rect }` |
| `Kit.clampRect` / `Kit.dragRect` | čistá matematika oken (testovatelná bez DOM) |
| `Kit.enhance()` (volá ho `Kit.init()`) | **tooltip a výběr pro celou stránku, i pro prvky přidané později** (MutationObserver): nativní `title` se převede na `data-tip` a zobrazí vlastním tooltipem (zpoždění 300 ms, u kurzoru, drží se na obrazovce, styl `--k-*`); `<select>` se nahradí rozbalovacím výběrem `k-select` (původní select zůstane skrytý a drží hodnotu, události `input`/`change` i `sel.value = …` fungují dál; `data-native` na selectu ho nechá nativní). Stránka bez skriptů scale volá jen `Kit.enhance()` |
| `Kit.convertTitle(node)` / `Kit.placeTip(…)` / `Kit.titleActions(…)` / `Kit.selectMirror(…)` / `Kit.selectFull(…)` / `Kit.isTabbable(…)` | čistá logika tooltipu, výběru a pasti fokusu (testovatelná bez DOM) |
| `Kit.trap(node)` | drží Tab uvnitř prvku (modální okna), jen mezi vykreslenými prvky (skrytý nativní select přeskočí); vrací funkci pro uvolnění |

## Kdo sadu používá a jak se mění
- Použití: `sprava/` (F10, editor, konzole). Další moduly (`prichod/`, `kresby/`, `loutna/`, `hospoda/`) si ji přidají podle postupu výše.
- Změna tokenu nebo třídy se dělá tady, v samostatném PR; moduly dostanou změnu při dalším buildu. Přejmenování nebo odstranění třídy `k-*` je nekompatibilní změna: napiš ji do popisu PR.
- Před PR: `node --test ui-kit/test.mjs` a `node ui-kit/check.mjs`.
