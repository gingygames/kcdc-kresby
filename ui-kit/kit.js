// ui-kit/kit.js: malý skript ke komponentám (toast, potvrzení, nápověda kláves, paměť nastavení, měřítko písma). Bez závislostí, ES5,
// funguje v CEF hry. `window.Kit`; v Node (testy) `require("./kit.js")` vrátí jen čisté funkce (`scaleFor`, `store`, `nearest`).
// Texty se vkládají jen jako textContent, nikdy jako HTML.
(function (root) {
  "use strict";

  /** násobek velikosti písma podle výšky okna hry: 1080 px = 1, nejméně 0,9, nejvíce 1,8 (4K) */
  function scaleFor(height) {
    var h = Number(height) || 1080;
    return Math.max(0.9, Math.min(1.8, Math.round((h / 1080) * 100) / 100));
  }

  /** úložiště s předponou; bez localStorage (nebo když hází) se drží jen v paměti */
  function store(ns, backend) {
    var mem = {};
    var ls = backend;
    if (ls === undefined) { try { ls = root.localStorage; } catch (e) { ls = null; } }
    var prefix = "kit:" + ns + ":";
    return {
      get: function (key, fallback) {
        var raw = null;
        try { raw = ls ? ls.getItem(prefix + key) : null; } catch (e) { raw = null; }
        if (raw === null || raw === undefined) raw = mem[prefix + key];     // úložiště nejde číst nebo nic nemá: zkus paměť
        try { return raw === null || raw === undefined ? fallback : JSON.parse(raw); } catch (e) { return fallback; }
      },
      set: function (key, value) {
        var raw = JSON.stringify(value);
        try { if (ls) ls.setItem(prefix + key, raw); else mem[prefix + key] = raw; } catch (e) { mem[prefix + key] = raw; }
      },
      del: function (key) {
        try { if (ls) ls.removeItem(prefix + key); } catch (e) { /* nic */ }
        delete mem[prefix + key];
      }
    };
  }

  /** Levenshteinova vzdálenost (pro „myslel jsi …?“) */
  function distance(a, b) {
    a = String(a); b = String(b);
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }

  /** nejbližší z `names` k `word`, když je dost podobné (předpona nebo vzdálenost do 1/3 délky, nejvýš 3); jinak null */
  function nearest(word, names) {
    var w = String(word || "").toLowerCase();
    if (!w || !names || !names.length) return null;
    var best = null, bestD = 1e9;
    names.forEach(function (n) {
      var l = String(n).toLowerCase();
      var d = distance(w, l);
      if (l.indexOf(w) === 0 || w.indexOf(l) === 0) d = Math.min(d, 1);
      if (d < bestD) { bestD = d; best = n; }
    });
    return bestD <= Math.min(3, Math.max(1, Math.floor(w.length / 3))) ? best : null;
  }

  /** obdélník {x,y,w,h} v mezích obrazovky: rozměry v rozsahu min..obrazovka, celé okno uvnitř (nikdy mimo obrazovku) */
  function clampRect(r, vw, vh, min) {
    min = min || { w: 320, h: 200 };
    var w = Math.round(Math.max(Math.min(min.w, vw), Math.min(Number(r && r.w) || min.w, vw)));
    var h = Math.round(Math.max(Math.min(min.h, vh), Math.min(Number(r && r.h) || min.h, vh)));
    var x = Math.round(Math.max(0, Math.min(Number(r && r.x) || 0, vw - w)));
    var y = Math.round(Math.max(0, Math.min(Number(r && r.y) || 0, vh - h)));
    return { x: x, y: y, w: w, h: h };
  }

  /** nový obdélník při tažení: `dir` je kombinace n, s, e, w (okraj nebo roh), "move" = posun; `d` = posun myši od začátku */
  function dragRect(start, dir, dx, dy, vw, vh, min) {
    min = min || { w: 320, h: 200 };
    var x = start.x, y = start.y, w = start.w, h = start.h;
    if (dir === "move") { x += dx; y += dy; }
    else {
      if (dir.indexOf("e") >= 0) w = start.w + dx;
      if (dir.indexOf("s") >= 0) h = start.h + dy;
      if (dir.indexOf("w") >= 0) { w = start.w - dx; x = start.x + dx; }
      if (dir.indexOf("n") >= 0) { h = start.h - dy; y = start.y + dy; }
      // minimum: okraj, který se táhne, se zastaví (protější zůstane na místě)
      if (w < min.w) { if (dir.indexOf("w") >= 0) x = start.x + start.w - min.w; w = min.w; }
      if (h < min.h) { if (dir.indexOf("n") >= 0) y = start.y + start.h - min.h; h = min.h; }
      if (x < 0) { if (dir.indexOf("w") >= 0) w += x; x = 0; }
      if (y < 0) { if (dir.indexOf("n") >= 0) h += y; y = 0; }
      if (x + w > vw) w = vw - x;
      if (y + h > vh) h = vh - y;
    }
    return clampRect({ x: x, y: y, w: w, h: h }, vw, vh, min);
  }

  /**
   * Nativní `title` hra (CEF bez okna) nevykreslí: místo tooltipu zůstane černý čtvereček. Proto se `title` převádí na `data-tip`
   * (vlastní tooltip, viz `tooltip`). Čistá funkce nad prvkem (testuje se bez DOM): vrací true, když převedla.
   */
  function convertTitle(node) {
    if (!node || !node.hasAttribute || !node.hasAttribute("title")) return false;
    if (String(node.tagName || "").toUpperCase() === "TITLE") return false;
    var t = node.getAttribute("title");
    node.removeAttribute("title");
    if (t && String(t).trim()) node.setAttribute("data-tip", String(t));
    else node.removeAttribute("data-tip");                                // `title = ""` tooltip ruší
    return true;
  }

  /**
   * Záznamy MutationObserveru (atribut `title`, s `attributeOldValue`) -> [{ node, act }]: "convert" (title je, převést),
   * "drop" (stránka title odebrala: zrušit data-tip) nebo null (poslední změnu udělala sada sama). `marks` (WeakMap/Map)
   * drží text, který sada u prvku sama odebrala; jeho záznam se pozná podle oldValue a značka se spotřebuje. Stav prvků se čte
   * dřív, než sada v tomto kole cokoli změní.
   */
  function titleActions(records, marks) {
    var nodes = [], kit = [], seen = typeof Map === "function" ? new Map() : null;
    for (var i = 0; i < records.length; i++) {
      var m = records[i];
      if (m.attributeName !== "title") continue;
      var n = m.target;
      var k = seen ? seen.get(n) : nodes.indexOf(n);
      if (k === undefined || k < 0) { k = nodes.length; nodes.push(n); if (seen) seen.set(n, k); }
      var own = marks.has(n) && marks.get(n) === m.oldValue;
      if (own) marks.delete(n);
      kit[k] = own;
    }
    return nodes.map(function (n, j) { return { node: n, act: n.hasAttribute("title") ? "convert" : kit[j] ? null : "drop" }; });
  }

  /** dá se na prvek přejít Tabem: není vypnutý ani skrytý, tabIndex >= 0 a je vykreslený (skrytý nativní select ne) */
  function isTabbable(n) {
    if (!n || n.disabled || n.hidden || !(n.tabIndex >= 0)) return false;
    return !!(n.getClientRects && n.getClientRects().length);
  }

  /** vlastní výběr na plnou šířku? Podle změřené šířky selectu vůči rodiči; neměřitelný (skrytý rodič, 0 px) podle CSS šířky (např. "100%") */
  function selectFull(w, parentW, cssWidth) {
    if (w > 0 && parentW > 0) return w / parentW > 0.9;
    var m = /^([\d.]+)%$/.exec(String(cssWidth || "").trim());
    return !!m && parseFloat(m[1]) >= 90;
  }

  /** stav tlačítka vlastního výběru podle selectu (popisek, vypnutí, skrytí, tooltip, třídy); čistá funkce */
  function selectMirror(sel, full) {
    var o = sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
    var st = sel.style || {};
    var cls = String(sel.className || "").replace(/(^|\s)k-select-native(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
    return {
      label: o ? String(o.text) : "",
      disabled: !!sel.disabled,
      hidden: !!sel.hidden || st.display === "none",
      visibility: st.visibility || "",
      tip: (sel.getAttribute && sel.getAttribute("data-tip")) || "",
      cls: (cls ? cls + " " : "") + "k-select" + (full ? " k-select--full" : "")
    };
  }

  /** poloha tooltipu u kurzoru (x, y) pro rozměr w×h: pod a vpravo od kurzoru, u okraje se překlopí; vždy celý na obrazovce */
  function placeTip(x, y, w, h, vw, vh) {
    var left = x + 14, top = y + 20;
    if (left + w > vw - 4) left = x - 14 - w;
    if (top + h > vh - 4) top = y - 12 - h;
    return { left: Math.round(Math.max(4, Math.min(left, vw - w - 4))), top: Math.round(Math.max(4, Math.min(top, vh - h - 4))) };
  }

  var api = { scaleFor: scaleFor, store: store, distance: distance, nearest: nearest, clampRect: clampRect, dragRect: dragRect, convertTitle: convertTitle, placeTip: placeTip,
    titleActions: titleActions, isTabbable: isTabbable, selectFull: selectFull, selectMirror: selectMirror };

  if (typeof document === "undefined") {
    if (typeof module !== "undefined") module.exports = api;
    return;
  }

  // ---------- DOM ----------
  function el(tag, props) {
    var node = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === undefined || v === null || v === false) return;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  /** nastaví --k-scale podle výšky okna a hlídá změnu velikosti */
  function init() {
    function apply() { document.documentElement.style.setProperty("--k-scale", String(scaleFor(root.innerHeight))); }
    apply();
    root.addEventListener("resize", apply);
    enhance();
  }

  var toastBox = null;
  /** oznámení: `kind` info | ok | warn | err; `opts.hint` = co dělat dál; mizí samo (chyba po 9 s, ostatní po 4 s) */
  function toast(text, kind, opts) {
    opts = opts || {};
    if (!toastBox) { toastBox = el("div", { class: "k-toasts", "aria-live": "polite", role: "status" }); document.body.appendChild(toastBox); }
    var msg = el("div", null, el("span", { text: String(text) }));
    if (opts.hint) msg.appendChild(el("span", { class: "k-toast-hint", text: String(opts.hint) }));
    var t = el("div", { class: "k-toast" + (kind && kind !== "info" ? " k-toast--" + kind : "") }, msg);
    toastBox.appendChild(t);
    while (toastBox.childNodes.length > 4) toastBox.removeChild(toastBox.firstChild);
    var gone = false;
    function close() {
      if (gone) return;
      gone = true;
      t.className += " is-out";
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 220);
    }
    setTimeout(close, opts.ms || (kind === "err" ? 9000 : 4000));
    t.addEventListener("click", close);
    return close;
  }

  /** drží Tab uvnitř prvku (jen vykreslené prvky: skrytý nativní select se přeskočí); vrací funkci, která past uvolní */
  function trap(node) {
    function onKey(e) {
      if (e.key !== "Tab") return;
      var all = node.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"), f = [];
      for (var i = 0; i < all.length; i++) if (isTabbable(all[i])) f.push(all[i]);
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    node.addEventListener("keydown", onKey);
    return function () { node.removeEventListener("keydown", onKey); };
  }

  /**
   * Potvrzení: `{ title, text, ok, cancel, danger }` -> Promise<boolean>. U nebezpečné akce je zaostřené „Zrušit“ a Enter nic nepotvrdí;
   * Esc a klik mimo okno = zrušit. `text` má říct, CO SE STANE (ne „Opravdu?“).
   */
  function confirm(o) {
    o = o || {};
    var previous = document.activeElement;
    return new Promise(function (resolve) {
      var okBtn = el("button", { class: "k-btn" + (o.danger ? " k-btn--danger" : ""), type: "button", text: o.ok || "Potvrdit" });
      var noBtn = el("button", { class: "k-btn k-btn--ghost", type: "button", text: o.cancel || "Zrušit" });
      var dialog = el("div", { class: "k-dialog", role: "alertdialog", "aria-modal": "true", "aria-label": o.title || "Potvrzení" },
        el("h2", { text: o.title || "Potvrdit?" }), o.text ? el("p", { text: o.text }) : null, el("div", { class: "k-actions" }, noBtn, okBtn));
      var modal = el("div", { class: "k-modal" }, dialog);
      var release = trap(dialog);
      function done(v) {
        release();
        document.removeEventListener("keydown", onKey, true);
        if (modal.parentNode) modal.parentNode.removeChild(modal);
        if (previous && previous.focus) try { previous.focus(); } catch (e) { /* nic */ }
        resolve(v);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
        else if (e.key === "Enter" && !o.danger && document.activeElement !== noBtn) { e.preventDefault(); e.stopPropagation(); done(true); }
      }
      okBtn.addEventListener("click", function () { done(true); });
      noBtn.addEventListener("click", function () { done(false); });
      modal.addEventListener("mousedown", function (e) { if (e.target === modal) done(false); });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(modal);
      (o.danger ? noBtn : okBtn).focus();
    });
  }

  /** řádek nápovědy kláves: `keys(node, [["Esc", "zavřít"], ["Ctrl+S", "uložit"]])` */
  function keys(node, list) {
    while (node.firstChild) node.removeChild(node.firstChild);
    node.className = (node.className.replace(/\bk-keys\b/g, "") + " k-keys").trim();
    list.forEach(function (pair) {
      var combo = String(pair[0]).split("+").map(function (k, i) { return [i ? "+" : null, el("kbd", { class: "k-kbd", text: k })]; });
      var span = el("span");
      combo.forEach(function (c) { if (c[0]) span.appendChild(document.createTextNode(c[0])); span.appendChild(c[1]); });
      span.appendChild(document.createTextNode(" " + pair[1]));
      node.appendChild(span);
    });
    return node;
  }

  api.el = el;
  api.init = init;
  api.toast = toast;
  api.confirm = confirm;
  api.keys = keys;
  api.trap = trap;

  /**
   * Přesouvatelné a zvětšitelné okno: `Kit.window(node, { handle, key, min, size })`.
   * Stránka (web view) pokrývá celou obrazovku a okno je v ní `position: fixed`. Posun táhnutím za `handle` (tlačítka a pole v něm
   * se nepočítají), změna velikosti úchyty na okrajích a v rozích, dvojklik na `handle` vrátí výchozí pozici. Pozice a velikost se
   * ukládají (`Kit.store("window")[key]`) a obnovují s ohlídáním, aby okno nebylo mimo obrazovku (i po změně rozlišení).
   * `size(vw, vh)` -> výchozí {w, h}; `min` -> nejmenší {w, h}. Vrací { reset, rect }.
   */
  function windowing(node, o) {
    o = o || {};
    var min = o.min || { w: 560, h: 360 };
    var st = store("window");
    var key = o.key || "main";
    var vw = function () { return root.innerWidth; };
    var vh = function () { return root.innerHeight; };
    var def = function () {
      var s = o.size ? o.size(vw(), vh()) : { w: Math.min(1180, vw() - 60), h: Math.min(760, vh() - 60) };
      return clampRect({ x: (vw() - s.w) / 2, y: (vh() - s.h) / 2, w: s.w, h: s.h }, vw(), vh(), min);
    };
    var rect = clampRect(st.get(key, null) || def(), vw(), vh(), min);
    var de = document.documentElement;
    de.className = (de.className + " k-windowed").trim();
    node.style.position = "fixed";

    function apply(save) {
      rect = clampRect(rect, vw(), vh(), min);
      node.style.left = rect.x + "px";
      node.style.top = rect.y + "px";
      node.style.width = rect.w + "px";
      node.style.height = rect.h + "px";
      node.style.right = node.style.bottom = "auto";
      de.style.setProperty("--k-win-x", rect.x + "px");
      de.style.setProperty("--k-win-y", rect.y + "px");
      de.style.setProperty("--k-win-w", rect.w + "px");
      de.style.setProperty("--k-win-h", rect.h + "px");
      if (save) st.set(key, rect);
    }
    apply(false);
    root.addEventListener("resize", function () { apply(false); });

    var handles = {};
    ["n", "s", "e", "w", "ne", "nw", "se", "sw"].forEach(function (d) {
      var hnd = el("div", { class: "k-rs k-rs-" + d, "data-dir": d, "aria-hidden": "true" });
      node.appendChild(hnd);
      handles[d] = hnd;
    });

    var drag = null;
    function begin(e, dir) {
      if (e.button !== undefined && e.button !== 0) return;
      drag = { dir: dir, sx: e.clientX, sy: e.clientY, start: { x: rect.x, y: rect.y, w: rect.w, h: rect.h } };
      document.body.className = (document.body.className + " k-dragging").trim();
      try { e.target.setPointerCapture(e.pointerId); } catch (x) { /* bez zachycení se táhne přes document */ }
      e.preventDefault();
    }
    function move(e) {
      if (!drag) return;
      rect = dragRect(drag.start, drag.dir, e.clientX - drag.sx, e.clientY - drag.sy, vw(), vh(), min);
      apply(false);
    }
    function end() {
      if (!drag) return;
      drag = null;
      document.body.className = document.body.className.replace(/\bk-dragging\b/g, "").trim();
      apply(true);
    }
    Object.keys(handles).forEach(function (d) {
      handles[d].addEventListener("pointerdown", function (e) { begin(e, d); });
    });
    if (o.handle) {
      o.handle.classList.add("k-drag-handle");
      o.handle.addEventListener("pointerdown", function (e) {
        if (e.target.closest && e.target.closest("button, input, select, textarea, a, kbd")) return;
        begin(e, "move");
      });
      o.handle.addEventListener("dblclick", function (e) {
        if (e.target.closest && e.target.closest("button, input, select, textarea, a")) return;
        reset();
      });
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);

    function reset() {
      st.del(key);
      rect = def();
      apply(false);
    }
    return { reset: reset, rect: function () { return { x: rect.x, y: rect.y, w: rect.w, h: rect.h }; } };
  }
  api.window = windowing;

  // ---------------------------------------------------------------------------
  // vlastní tooltip a výběr (nativní `title` a rozbalovací seznam `<select>` hra nevykreslí: zůstane černý čtvereček)

  var enhanced = false;
  var kitRm = new WeakMap();    // prvek -> title, který sada sama odebrala (její záznam v observeru se nepočítá jako odebrání stránkou)
  var tipOwn = new WeakMap();   // prvek -> data-tip, který vznikl z title
  var rmAttr = Element.prototype.removeAttribute;
  /** zapne tooltip a vlastní výběr pro celou stránku (včetně prvků přidaných později); `Kit.init()` ho volá; opakované volání nic nedělá */
  function enhance() {
    if (enhanced) return;
    enhanced = true;
    tooltipStart();
    selectStart();
    // `removeAttribute("title")` u už převedeného prvku nic nezmění (title tam není), proto zruší i data-tip, který z title vznikl
    Element.prototype.removeAttribute = function (name) {
      if (String(name).toLowerCase() === "title" && tipOwn.has(this) && !this.hasAttribute("title") && tipOwn.get(this) === this.getAttribute("data-tip")) dropTip(this);
      return rmAttr.apply(this, arguments);
    };
    document.addEventListener("visibilitychange", function () { if (document.hidden) { tipHide(); selectClose(true); } });
    var obs = new MutationObserver(function (list) {
      var titles = [], found = [], i;
      for (i = 0; i < list.length; i++) if (list[i].type === "attributes") titles.push(list[i]);
      // title: nejdřív podle stavu na začátku kola (než sada něco změní), pak nové a odebrané prvky
      titleActions(titles, kitRm).forEach(function (a) { if (a.act === "convert") kitConvert(a.node); else if (a.act === "drop") dropTip(a.node); });
      for (i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.type !== "childList") continue;
        m.removedNodes.forEach(function (n) { if (n.nodeType === 1) unscan(n); });
        m.addedNodes.forEach(function (n) { if (n.nodeType === 1 && document.contains(n)) scan(n, found); });
      }
      selectEnhanceAll(found);
    });
    // pozorovat už před prvním průchodem: odebrání title sadou pak přijde jako záznam a spotřebuje značku
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"], attributeOldValue: true });
    var found0 = [];
    scan(document.documentElement, found0);
    selectEnhanceAll(found0);
  }
  /** převede title prvku a zapamatuje si, že title odebrala sada */
  function kitConvert(n) {
    var t = n && n.getAttribute ? n.getAttribute("title") : null;
    if (!convertTitle(n)) return false;
    kitRm.set(n, t);
    if (n.hasAttribute("data-tip")) tipOwn.set(n, n.getAttribute("data-tip")); else tipOwn.delete(n);
    tipSync(n);
    return true;
  }
  function dropTip(n) {
    tipOwn.delete(n);
    rmAttr.call(n, "data-tip");
    tipSync(n);
  }
  /** projde podstrom: převede title, selecty přidá do `found` (vylepší je až `selectEnhanceAll` najednou) */
  function scan(root0, found) {
    kitConvert(root0);
    var all = root0.querySelectorAll ? root0.querySelectorAll("[title]") : [];
    for (var i = 0; i < all.length; i++) kitConvert(all[i]);
    if (root0.tagName === "SELECT") found.push(root0);
    var s = root0.querySelectorAll ? root0.querySelectorAll("select") : [];
    for (var j = 0; j < s.length; j++) found.push(s[j]);
  }
  /** odebraný podstrom: selecty, které už nejsou v dokumentu, uvolní (observer, posluchač, tlačítko); přesunuté zůstanou */
  function unscan(root0) {
    if (root0.tagName === "SELECT" && !document.contains(root0)) selectDrop(root0);
    var s = root0.querySelectorAll ? root0.querySelectorAll("select") : [];
    for (var j = 0; j < s.length; j++) if (!document.contains(s[j])) selectDrop(s[j]);
  }

  var tip = null, tipTimer = null, tipFor = null, lastX = 0, lastY = 0;
  function tipHide() {
    clearTimeout(tipTimer);
    tipTimer = null;
    tipFor = null;
    if (tip) tip.className = "k-tip";
  }
  function tipShow(target, byKey) {
    var text = target.getAttribute("data-tip");
    if (!text) return;
    if (!tip) { tip = el("div", { class: "k-tip", role: "tooltip" }); document.body.appendChild(tip); }
    tip.textContent = text;
    tip.className = "k-tip is-on";
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var r = target.getBoundingClientRect();
    var at = byKey ? placeTip(r.left, r.bottom - 14, w, h, root.innerWidth, root.innerHeight) : placeTip(lastX, lastY, w, h, root.innerWidth, root.innerHeight);
    tip.style.left = at.left + "px";
    tip.style.top = at.top + "px";
  }
  /** zobrazený tooltip prvku `n` po změně jeho data-tip: nový text, nebo schovat */
  function tipSync(n) {
    if (!tip || tipFor !== n || tip.className.indexOf("is-on") < 0) return;
    var t = n.getAttribute("data-tip");
    if (t) tip.textContent = t; else tipHide();
  }
  function tooltipStart() {
    function target(e) { return e.target && e.target.closest ? e.target.closest("[data-tip]") : null; }
    document.addEventListener("mouseover", function (e) {
      lastX = e.clientX; lastY = e.clientY;
      var t = target(e);
      if (t === tipFor) return;
      tipHide();
      if (!t) return;
      tipFor = t;
      tipTimer = setTimeout(function () { tipShow(t, false); }, 300);
    }, true);
    document.addEventListener("mousemove", function (e) {
      lastX = e.clientX; lastY = e.clientY;
      if (tipFor && tip && tip.className.indexOf("is-on") >= 0) {
        var r = tipFor.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) tipHide();
      }
    }, true);
    document.addEventListener("mouseout", function (e) { if (!e.relatedTarget) tipHide(); }, true);
    ["mousedown", "keydown", "wheel", "scroll", "blur"].forEach(function (n) { document.addEventListener(n, tipHide, true); });
    document.addEventListener("focusin", function (e) {
      var t = target(e);
      if (!t || !(e.target.matches && e.target.matches(":focus-visible"))) return;
      tipHide();
      tipFor = t;
      tipTimer = setTimeout(function () { tipShow(t, true); }, 300);
    });
    document.addEventListener("focusout", tipHide);
  }

  // --- vlastní výběr místo <select> ---
  var sels = [];            // { sel, btn, label, full, obs, onChange }
  var openSel = null;       // { rec, list, items, active, onKey }
  function selectRec(sel) { for (var i = 0; i < sels.length; i++) if (sels[i].sel === sel) return sels[i]; return null; }

  function selectStart() {
    document.addEventListener("mousedown", function (e) {
      if (openSel && !(openSel.list.contains(e.target) || openSel.rec.btn.contains(e.target))) selectClose();
    }, true);
    root.addEventListener("resize", function () { selectClose(); });
    root.addEventListener("blur", function () { selectClose(); });
    document.addEventListener("scroll", function (e) { if (openSel && !openSel.list.contains(e.target)) selectClose(); }, true);
    // klávesy otevřeného seznamu: zachytávání na window (registrované při startu sady, tedy před posluchači stránky),
    // obsloužená klávesa stopImmediatePropagation; Esc tak nezavře zároveň okno pod seznamem
    root.addEventListener("keydown", function (e) { if (openSel) openSel.onKey(e); }, true);
    // form.reset(): hodnoty se vrátí až po události reset, proto popisky až potom
    document.addEventListener("reset", function (e) {
      var form = e.target;
      setTimeout(function () { sels.forEach(function (r) { if (form && form.contains && form.contains(r.sel)) selectRefresh(r); }); }, 0);
    }, true);
    // <label for> (nebo label kolem selectu) zaostří vlastní tlačítko místo skrytého selectu
    document.addEventListener("click", function (e) {
      var lab = e.target && e.target.closest ? e.target.closest("label") : null;
      var rec = lab && lab.control ? selectRec(lab.control) : null;
      if (!rec || rec.btn.contains(e.target)) return;
      e.preventDefault();
      try { rec.btn.focus({ preventScroll: true }); } catch (x) { /* nic */ }
    }, true);
  }

  /** promítne stav selectu do tlačítka (popisek, vypnutí, skrytí, třídy, tooltip); píše jen to, co se změnilo */
  function selectRefresh(rec) {
    var m = selectMirror(rec.sel, rec.full), b = rec.btn;
    var text = m.label || " ";
    if (rec.label.textContent !== text) rec.label.textContent = text;
    if (b.className !== m.cls) b.className = m.cls;
    if (b.disabled !== m.disabled) b.disabled = m.disabled;
    if (b.hidden !== m.hidden) b.hidden = m.hidden;
    if (b.style.visibility !== m.visibility) b.style.visibility = m.visibility;
    if (m.tip) { if (b.getAttribute("data-tip") !== m.tip) b.setAttribute("data-tip", m.tip); }
    else if (b.hasAttribute("data-tip")) b.removeAttribute("data-tip");
    if ((m.hidden || m.disabled) && openSel && openSel.rec === rec) selectClose(true);
  }

  function selectCandidate(sel) {
    return !sel.hasAttribute("multiple") && !sel.hasAttribute("data-native") && !(sel.size && sel.size > 1) && !!sel.parentNode;
  }
  /** vylepší seznam selectů najednou: nejdřív se všechny změří (čtení), pak se vkládají tlačítka (zápis), bez opakovaného layoutu */
  function selectEnhanceAll(list) {
    var todo = [], i;
    for (i = 0; i < list.length; i++) {
      var s = list[i], rec = selectRec(s);
      if (rec) {                                        // už vylepšený (přesun v dokumentu): tlačítko patří hned za select
        if (s.parentNode && s.nextSibling !== rec.btn) s.parentNode.insertBefore(rec.btn, s.nextSibling);
        continue;
      }
      if (selectCandidate(s) && todo.indexOf(s) < 0) todo.push(s);
    }
    var full = todo.map(function (s) {
      var w = s.offsetWidth, pw = s.parentNode.clientWidth || 0;
      return selectFull(w, pw, w > 0 && pw > 0 ? "" : (root.getComputedStyle(s) || {}).width);
    });
    for (i = 0; i < todo.length; i++) selectBuild(todo[i], full[i]);
  }
  function selectEnhance(sel) { if (sel) selectEnhanceAll([sel]); }

  function selectBuild(sel, full) {
    kitConvert(sel);
    var label = el("span", { class: "k-select-label" });
    var btn = el("button", { type: "button", class: "k-select", "aria-haspopup": "listbox", "aria-expanded": "false" }, label, el("span", { class: "k-select-caret", "aria-hidden": "true", text: "▾" }));
    // full: plná šířka, když ji měl původní select (ve formulářích), jinak podle obsahu
    var rec = { sel: sel, btn: btn, label: label, full: full };
    sels.push(rec);
    sel.parentNode.insertBefore(btn, sel.nextSibling);
    sel.classList.add("k-select-native");             // display: none !important (ani sel.style.display = "" ho neukáže)
    selectRefresh(rec);

    // programové změny (`sel.value = x`, `selectedIndex`) se promítnou do tlačítka
    ["value", "selectedIndex"].forEach(function (k) {
      var d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, k) || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(HTMLSelectElement.prototype), k);
      if (!d || !d.set) return;
      Object.defineProperty(sel, k, { configurable: true, get: function () { return d.get.call(sel); }, set: function (v) { d.set.call(sel, v); selectRefresh(rec); } });
    });
    // atributy selectu (hidden, class, style, disabled, data-tip) a možnosti; `option.selected = true` se pozná při otevření a fokusu
    rec.obs = new MutationObserver(function () { selectRefresh(rec); });
    rec.obs.observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "hidden", "class", "style", "data-tip", "selected", "label"], characterData: true });
    rec.onChange = function () { selectRefresh(rec); };
    sel.addEventListener("change", rec.onChange);

    btn.addEventListener("focus", function () { selectRefresh(rec); });
    btn.addEventListener("click", function () { if (openSel && openSel.rec === rec) selectClose(); else selectOpen(rec); });
    btn.addEventListener("keydown", function (e) {
      if (openSel && openSel.rec === rec) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") { e.preventDefault(); selectOpen(rec); }
    });
  }
  /** uvolní select odebraný z dokumentu: observer, posluchač, přepsané vlastnosti, tlačítko; po návratu do dokumentu se vylepší znovu */
  function selectDrop(sel) {
    var rec = selectRec(sel);
    if (!rec) return;
    if (openSel && openSel.rec === rec) selectClose(true);
    rec.obs.disconnect();
    sel.removeEventListener("change", rec.onChange);
    delete sel.value;
    delete sel.selectedIndex;
    sel.classList.remove("k-select-native");
    if (rec.btn.parentNode) rec.btn.parentNode.removeChild(rec.btn);
    sels.splice(sels.indexOf(rec), 1);
  }

  /** zavře otevřený seznam; fokus se vrátí na tlačítko (bez posunu stránky), `noFocus === true` ho nechá být */
  function selectClose(noFocus) {
    if (!openSel) return;
    if (openSel.list.parentNode) openSel.list.parentNode.removeChild(openSel.list);
    var b = openSel.rec.btn;
    openSel = null;
    b.setAttribute("aria-expanded", "false");
    if (noFocus !== true) try { b.focus({ preventScroll: true }); } catch (e) { /* nic */ }
  }
  function selectPick(rec, index) {
    var sel = rec.sel;
    var changed = sel.selectedIndex !== index;
    sel.selectedIndex = index;
    selectClose();
    if (changed) {
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  function selectOpen(rec) {
    selectClose(true);
    tipHide();
    var sel = rec.sel;
    selectRefresh(rec);                                 // popisek mohl zastarat (`option.selected = true`)
    if (sel.disabled || rec.btn.hidden) return;
    var list = el("div", { class: "k-select-list", role: "listbox" });
    var items = [];
    for (var i = 0; i < sel.children.length; i++) {
      var c = sel.children[i];
      if (c.tagName === "OPTGROUP") {
        list.appendChild(el("div", { class: "k-select-group", text: c.label }));
        for (var j = 0; j < c.children.length; j++) addItem(c.children[j]);
      } else addItem(c);
    }
    function addItem(o) {
      var idx = o.index;
      var d = el("div", { class: "k-select-item" + (o.disabled ? " is-disabled" : "") + (idx === sel.selectedIndex ? " is-sel" : ""), role: "option", text: o.text || "\u00a0" });
      if (!o.disabled) d.addEventListener("click", function () { selectPick(rec, idx); });
      d.addEventListener("mousemove", function () { if (!o.disabled) activate(items.indexOf(rec2)); });
      var rec2 = { el: d, index: idx, disabled: o.disabled };
      items.push(rec2);
      list.appendChild(d);
    }
    var state = { rec: rec, list: list, items: items, active: -1 };
    function activate(n) {
      if (n < 0 || n >= items.length) return;
      if (state.active >= 0) items[state.active].el.classList.remove("is-active");
      state.active = n;
      items[n].el.classList.add("is-active");
      if (items[n].el.scrollIntoView) items[n].el.scrollIntoView({ block: "nearest" });
    }
    function step(dir) {
      var n = state.active;
      for (var k = 0; k < items.length; k++) {
        n = (n + dir + items.length) % items.length;
        if (!items[n].disabled) return activate(n);
      }
    }
    // volá ho posluchač na window (selectStart); obsloužená klávesa se dál nedostane k žádnému posluchači stránky
    state.onKey = function (e) {
      var k = e.key;
      function eat() { e.preventDefault(); e.stopImmediatePropagation(); }
      if (k === "Escape") { eat(); selectClose(); }
      else if (k === "ArrowDown") { eat(); step(1); }
      else if (k === "ArrowUp") { eat(); step(-1); }
      else if (k === "Enter" || k === " ") { eat(); if (state.active >= 0) selectPick(rec, items[state.active].index); }
      else if (k === "Tab") selectClose();
      else if (k && k.length === 1) {
        var ch = k.toLowerCase();
        for (var q = 1; q <= items.length; q++) {
          var m = (state.active + q) % items.length;
          if (!items[m].disabled && items[m].el.textContent.toLowerCase().indexOf(ch) === 0) { activate(m); break; }
        }
        e.stopImmediatePropagation();
      }
    };
    document.body.appendChild(list);
    openSel = state;
    rec.btn.setAttribute("aria-expanded", "true");
    var r = rec.btn.getBoundingClientRect();
    list.style.minWidth = r.width + "px";
    var h = list.offsetHeight;
    var below = root.innerHeight - r.bottom - 6;
    var top = h <= below || below >= r.top ? r.bottom + 2 : r.top - 2 - Math.min(h, r.top - 6);
    list.style.maxHeight = Math.max(120, h <= below || below >= r.top ? below : r.top - 8) + "px";
    list.style.left = Math.max(4, Math.min(r.left, root.innerWidth - list.offsetWidth - 4)) + "px";
    list.style.top = Math.max(4, top) + "px";
    var cur = 0;
    for (var z = 0; z < items.length; z++) if (items[z].index === sel.selectedIndex) cur = z;
    activate(cur);
  }
  api.enhance = enhance;
  api.select = selectEnhance;
  root.Kit = api;
})(typeof window !== "undefined" ? window : globalThis);
