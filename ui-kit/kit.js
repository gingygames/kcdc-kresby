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

  var api = { scaleFor: scaleFor, store: store, distance: distance, nearest: nearest, clampRect: clampRect, dragRect: dragRect };

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

  /** drží Tab uvnitř prvku; vrací funkci, která past uvolní */
  function trap(node) {
    function onKey(e) {
      if (e.key !== "Tab") return;
      var f = node.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
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
  root.Kit = api;
})(typeof window !== "undefined" ? window : globalThis);
