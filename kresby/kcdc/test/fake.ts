// Falešné API Kingdoms Connected 1.7.1 pro testy kreseb: sestavený resource (dist/kresby) běží v node:vm -
// server v jednom kontextu, každý hráč má vlastní klientský kontext. Zprávy mezi nimi jdou přes JSON jako ve hře
// (player.emit = JSON řetězec, emitServer = objekt -> JSON). Jen tolik globálů, kolik kresby používají, s chováním
// podle dokumentace a typů (@kingdomsconnected/types): limity Gizmos, 16 KiB dat předmětu, Inventory po řádcích,
// Dialogue po stránkách, Scaleform clip s kreslicím API.
import * as nodeFs from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
type Fn = (...a: any[]) => any;

export class Vec {
  constructor(public x = 0, public y = 0, public z = 0) {}
  distance(o: { x: number; y: number; z: number }) {
    return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z);
  }
}

// ---------------------------------------------------------------------------
// server

export interface Row {
  id: string;
  item: string;
  name: string;
  amount: number;
  quality: number;
  health: number;
  condition: number;
  equipped: number;
  metadata: Record<string, any>;
}

export class Quat {
  constructor(public w: number, public x: number, public y: number, public z: number) {}
}

// fs pro server: skutečné soubory, ale fs.promises.writeFile hotové hned (falešné časovače nečekají na I/O)
const fakeFs = { ...nodeFs, promises: { writeFile: async (p: string, d: string | Uint8Array) => nodeFs.writeFileSync(p, d) } };

export function makeServer(opts: { config?: object; storage?: Map<string, string>; most?: Record<string, any> | null; sprava?: Record<string, any> | null; assetsDir?: string } = {}) {
  const on = new Map<string, Fn[]>();
  const onClient = new Map<string, Fn>();
  const exportsReg = new Map<string, unknown>();
  const dialogs: { player: number; page: any; session: number; open: boolean }[] = [];
  const chat: [number, string][] = [];
  const props: { model: string; pos: any; rot: any; scale: any; physics?: string; destroyed: boolean }[] = [];
  const running = new Set<string>(); // spuštěné balíčky assetů (resource bez skriptů)
  const reloads: { novych: string[]; zmenenych: string[] }[] = [];
  const vendors = new Map<number, { stock: any[]; opened: number[] }>();
  const registered = new Map<string, any>();
  const logs: string[] = [];
  let session = 0;
  let rowSeq = 0;
  const raycastHit = { value: { position: new Vec(0, 3, 1.6), normal: new Vec(0, -1, 0) } as any };
  const storage = opts.storage ?? new Map<string, string>();

  /** handlery serveru jsou asynchronní (guard výsledek nevrací): počkat, až doběhnou jejich mikroúlohy */
  const settle = async () => {
    for (let i = 0; i < 400; i++) await Promise.resolve();
  };
  const fire = async (name: string, ...args: unknown[]) => {
    await Promise.all((on.get(name) ?? []).map((f) => f(...args)));
    await settle();
  };

  class Player {
    static list: Player[] = [];
    emitted: [string, any][] = [];
    rows: Row[] = [];
    revision = 1;
    ready = true;
    lookDirection = new Vec(0, 1, 0);
    client: ((name: string, payload: any) => void) | null = null;
    constructor(public id: number, public nickname: string, public position: Vec) {}
    emit(name: string, json?: string) {
      const payload = json ? JSON.parse(json) : undefined;
      this.emitted.push([name, payload]);
      this.client?.(name, payload);
    }
    static all() {
      return Player.list;
    }
    static getById(id: number) {
      return Player.list.find((p) => p.id === id) ?? null;
    }
    last(name: string) {
      return this.emitted.filter((e) => e[0] === name).at(-1)?.[1];
    }
    all(name: string) {
      return this.emitted.filter((e) => e[0] === name).map((e) => e[1]);
    }
    count(name: string) {
      return this.rows.filter((r) => r.name === name).reduce((n, r) => n + r.amount, 0);
    }
  }

  const resolve = (item: string) => {
    for (const [id, def] of registered) if (def.guid === item || id === item) return { guid: def.guid, name: id, def };
    return { guid: "n-" + item.replace(/^n-/, ""), name: item.replace(/^n-/, ""), def: null as any };
  };

  const Inventory = {
    get: (p: Player) => ({ ready: true, revision: p.revision, items: p.rows.map((r) => JSON.parse(JSON.stringify(r))), harvested: undefined, quickslots: null }),
    add(p: Player, req: { item: string; amount: number; metadata?: any; notify?: boolean }) {
      const r = resolve(req.item);
      const meta = JSON.parse(JSON.stringify(req.metadata ?? {}));
      if (meta.custom && JSON.stringify(meta.custom).length > 16384) return { ok: false, code: "invalidMetadata", revision: 0, items: [] };
      if (meta.custom && (!r.def || /[\u0000-\u001f]/.test((meta.custom.name ?? "") + (meta.custom.description ?? "")))) return { ok: false, code: "invalidMetadata", revision: 0, items: [] };
      const stackable = r.def ? r.def.stackable !== false : true;
      const items: { id: string; amount: number }[] = [];
      if (stackable) {
        let row = p.rows.find((x) => x.item === r.guid && JSON.stringify(x.metadata) === JSON.stringify(meta));
        if (!row) p.rows.push((row = { id: "r" + ++rowSeq, item: r.guid, name: r.name, amount: 0, quality: 1, health: 1, condition: 1, equipped: 0, metadata: meta }));
        row.amount += req.amount;
        items.push({ id: row.id, amount: req.amount });
      } else {
        for (let i = 0; i < req.amount; i++) {
          const row = { id: "r" + ++rowSeq, item: r.guid, name: r.name, amount: 1, quality: 1, health: 1, condition: 1, equipped: 0, metadata: JSON.parse(JSON.stringify(meta)) };
          p.rows.push(row);
          items.push({ id: row.id, amount: 1 });
        }
      }
      p.revision++;
      return { ok: true, code: "", revision: p.revision, items };
    },
    remove(p: Player, req: { units: { id: string; amount: number }[] }) {
      for (const u of req.units) {
        const r = p.rows.find((x) => x.id === u.id);
        if (!r || r.amount < u.amount) return { ok: false, code: "insufficientItems", revision: 0, items: [] };
      }
      for (const u of req.units) {
        const r = p.rows.find((x) => x.id === u.id)!;
        r.amount -= u.amount;
        if (r.amount <= 0) p.rows.splice(p.rows.indexOf(r), 1);
      }
      p.revision++;
      return { ok: true, code: "", revision: p.revision, items: [] };
    },
    updateCustom(p: Player, req: { id: string; name?: string | null; description?: string | null; data?: any }) {
      const r = p.rows.find((x) => x.id === req.id);
      if (!r) return { ok: false, code: "invalidItem", revision: 0, items: [] };
      const c = { ...(r.metadata.custom ?? {}) };
      if (req.name !== undefined) c.name = req.name ?? undefined;
      if (req.description !== undefined) c.description = req.description ?? undefined;
      if (req.data !== undefined) c.data = req.data ?? undefined;
      if (/[\u0000-\u001f]/.test((c.name ?? "") + (c.description ?? ""))) return { ok: false, code: "invalidMetadata", revision: 0, items: [] };
      if (JSON.stringify(c).length > 16384) return { ok: false, code: "invalidMetadata", revision: 0, items: [] };
      r.metadata = { ...r.metadata, custom: JSON.parse(JSON.stringify(c)) };
      p.revision++;
      return { ok: true, code: "", revision: p.revision, items: [] };
    },
  };

  const imports: Record<string, Record<string, any> | null> = { most: opts.most ?? null, sprava: opts.sprava ?? null };

  const ctx = vm.createContext({
    Events: {
      on: (n: string, f: Fn) => (on.set(n, [...(on.get(n) ?? []), f]), () => {}),
      onClient: (n: string, f: Fn) => (onClient.set(n, f), () => {}),
      emitAllClients: () => {},
    },
    Player,
    Inventory,
    Items: {
      register(id: string, def: any) {
        if (/[\u0000-\u001f]/.test(def.name + (def.description ?? "") + (def.useLabel ?? ""))) throw new Error("Invalid custom item text");
        const old = registered.get(id);
        const canon = (o: any) => JSON.stringify(Object.keys(o).filter((k) => k !== "guid" && o[k] !== undefined).sort().map((k) => [k, o[k]]));
        if (old && canon(old) !== canon(def)) throw new Error("conflicting registration " + id);
        const guid = "c-" + id;
        registered.set(id, { ...def, guid });
        return guid;
      },
    },
    Chat: { sendToPlayer: (p: Player, text: string) => void chat.push([p.id, text]) },
    Dialogue: {
      open: (player: number, page: any) => (dialogs.push({ player, page, session: ++session, open: true }), session),
      update: (s: number, page: any) => {
        const d = dialogs.find((x) => x.session === s && x.open);
        if (!d) return false;
        d.page = page;
        return true;
      },
      close: (s: number) => {
        const d = dialogs.find((x) => x.session === s);
        if (d) d.open = false;
        return !!d;
      },
    },
    Vendor: {
      create: () => (vendors.set(vendors.size + 1, { stock: [], opened: [] }), vendors.size),
      setStock: (v: number, rows: any[]) => ((vendors.get(v)!.stock = rows), true),
      open: (v: number, player: number) => (vendors.get(v)!.opened.push(player), 1),
    },
    Prop: {
      spawn: (model: string, pos: any, rot: any, scale?: any, physics?: string) => {
        // KCDC: streamovaný model musí mít běžící resource, který ho nese
        const m = /^objects\/kcdc\/([^/]+)\/(.+)$/.exec(model);
        if (m && opts.assetsDir) {
          if (!running.has(m[1]) || !existsSync(join(opts.assetsDir, m[1], "stream", model))) throw new Error(`Prop.spawn: no running resource ships ${model}`);
        }
        const pr = { model, pos, rot, scale, physics, destroyed: false, destroy: () => void (pr.destroyed = true) };
        props.push(pr);
        return pr;
      },
    },
    Quaternion: Quat,
    World: {
      raycast: async () => ({ answered: true, reason: "", hit: raycastHit.value, hits: raycastHit.value ? [raycastHit.value] : [] }),
    },
    Vector3: Vec,
    Imports: {
      get: (r: string) => {
        if (!imports[r]) throw new Error("resource " + r + " neběží");
        return imports[r];
      },
    },
    Exports: {
      register: (n: string, f: unknown) => (exportsReg.set(n, f), true),
      get: (r: string, n: string) => {
        if (!imports[r]) throw new Error("resource " + r + " neběží");
        return imports[r]![n];
      },
    },
    console: { log: (t: string) => void logs.push(String(t)) },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON, Math, Promise,
    ...(opts.assetsDir ? { require: (id: string) => (id === "node:fs" ? fakeFs : id === "node:net" ? {} : undefined) } : {}),
  });
  (ctx as any).__dir = opts.assetsDir ?? "";
  /** chování háku přenačtení: mute = resourceStart nepřijde (hák selhal potichu), delayMs = za jak dlouho přijde */
  const reloadCtl = { mute: false, delayMs: 50 };
  (ctx as any).__reload = (novych: string[], zmenenych: string[]) => {
    reloads.push({ novych: [...novych], zmenenych: [...zmenenych] });
    if (reloadCtl.mute) return;
    // jako konzole: restart / start balíčku, za chvíli resourceStart
    setTimeout(() => {
      // jako KCDC: resourceStart (skripty) přijde dřív, než je balíček assetů zabalený
      for (const n of [...novych, ...zmenenych]) void fire("resourceStart", n);
      setTimeout(() => [...novych, ...zmenenych].forEach((n) => running.add(n)), 300);
    }, reloadCtl.delayMs);
  };
  const storageCfg = `{
    get: (k) => __st.has(k) ? JSON.parse(__st.get(k)) : undefined,
    set: (k, v) => (v === null ? __st.delete(k) : __st.set(k, JSON.stringify(v)), true),
    delete: (k) => __st.delete(k),
    keys: (p) => [...__st.keys()].filter((k) => k.startsWith(p)).sort(),
  }`;
  (ctx as any).__st = storage;
  vm.runInContext(`globalThis.KRESBY_CONFIG = Object.assign({ storage: ${storageCfg} }, ${JSON.stringify(opts.config ?? { admini: ["Henry"] })});`, ctx);
  if (opts.assetsDir) vm.runInContext(`KRESBY_CONFIG.svet = Object.assign({}, KRESBY_CONFIG.svet, { slozka: __dir, konzole: false, reload: __reload, reloadMs: 5000 });`, ctx);
  vm.runInContext(read("dist/kresby/server.js"), ctx);

  const players = {
    henry: new Player(1, "Henry", new Vec(0, 0, 0)),
    hans: new Player(2, "Hans", new Vec(4, 0, 0)),
    far: new Player(3, "Daleko", new Vec(900, 0, 0)),
  };
  Player.list = Object.values(players);

  const lastDialog = (p: Player) => dialogs.filter((x) => x.player === p.id && x.open).at(-1);
  return {
    ...players,
    Player,
    ctx,
    storage,
    dialogs,
    chat,
    props,
    vendors,
    registered,
    logs,
    exportsReg,
    imports,
    raycastHit,
    running,
    reloads,
    reloadCtl,
    on,
    fire,
    start: () => fire("resourceStart", "kresby"),
    stop: () => fire("resourceStop", "kresby"),
    cmd: (p: Player, line: string) => fire("playerCommand", p, "kresby", line ? line.split(" ") : []),
    client: (name: string, p: Player, payload: unknown = {}) => {
      onClient.get(name)!(p, JSON.parse(JSON.stringify(payload)));
      return settle();
    },
    settle,
    dialog: lastDialog,
    /** vybere v otevřeném dialogu volbu, jejíž text obsahuje `text` (i přes stránky "Další…") */
    async pick(p: Player, text: string) {
      for (let i = 0; i < 400; i++) await Promise.resolve(); // dialog otevírá až pokračování předchozí volby
      for (let i = 0; i < 10; i++) {
        const d = lastDialog(p);
        if (!d) throw new Error(`hráč ${p.nickname} nemá otevřený dialog (chtěl "${text}")`);
        const o = d.page.options.find((x: any) => x.text.includes(text));
        if (o) {
          if (o.enabled === false) throw new Error(`"${text}" je zašedlé`);
          await fire("dialogueChoice", d.session, p, o.id);
          return;
        }
        const next = d.page.options.find((x: any) => x.id === "#dalsi");
        if (!next) throw new Error(`"${text}" není v nabídce: ${d.page.options.map((x: any) => x.text).join(" | ")}`);
        await fire("dialogueChoice", d.session, p, next.id);
      }
    },
    options: (p: Player) => (lastDialog(p)?.page.options ?? []).map((x: any) => x.text as string),
    use: (p: Player, row: Row) => fire("playerCustomItemUse", p, JSON.parse(JSON.stringify(row)), p.revision),
  };
}

export type FakeServer = ReturnType<typeof makeServer>;

// ---------------------------------------------------------------------------
// klient

export class Clip {
  children: Clip[] = [];
  calls: any[][] = [];
  handlers: Record<string, Fn> = {};
  props: Record<string, any> = { x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true };
  members: Record<string, any> = {};
  text = "";
  style: Record<string, any> = {};
  minX = Infinity;
  maxX = -Infinity;
  valid = true;
  constructor(public screen: Screen, public parent: Clip | null, public key: string) {}
  createClip() {
    const c = new Clip(this.screen, this, this.key + "/" + this.children.length);
    this.children.push(c);
    return c;
  }
  createText(o: any) {
    const c = this.createClip();
    c.text = o.text ?? "";
    c.props.x = o.x;
    c.props.y = o.y;
    c.props.width = o.width;
    c.props.height = o.height;
    c.style.isText = true;
    return c;
  }
  invoke(m: string, a: any[] = []) {
    this.calls.push([m, ...a]);
    this.screen.calls++;
    if (m === "clear") (this.minX = Infinity), (this.maxX = -Infinity), (this.calls = []);
    if (m === "moveTo" || m === "lineTo") (this.minX = Math.min(this.minX, a[0])), (this.maxX = Math.max(this.maxX, a[0]));
    return null;
  }
  abs(): { x: number; y: number; sx: number; sy: number } {
    const p = this.parent ? this.parent.abs() : { x: 0, y: 0, sx: 1, sy: 1 };
    return { x: p.x + this.props.x * p.sx, y: p.y + this.props.y * p.sy, sx: p.sx * this.props.scaleX, sy: p.sy * this.props.scaleY };
  }
  get(m: string) {
    if (m === "_width") return this.maxX > this.minX ? (this.maxX - this.minX) * this.props.scaleX : 0;
    if (m === "_xmouse" || m === "_ymouse") {
      if (!this.screen.mouseWorks) return null;
      const a = this.abs();
      return m === "_xmouse" ? (this.screen.mouse.x - a.x) / a.sx : (this.screen.mouse.y - a.y) / a.sy;
    }
    return this.props[m] ?? null;
  }
  set(o: any) {
    Object.assign(this.props, o);
    return true;
  }
  setMember(k: string, v: any) {
    this.members[k] = v;
    return true;
  }
  setTextStyle(o: any = {}) {
    Object.assign(this.style, o);
    return true;
  }
  setText(t: string) {
    this.text = t;
    return true;
  }
  getText() {
    return this.text;
  }
  on(e: string, f: Fn) {
    this.handlers[e] = f;
    return true;
  }
  remove() {
    this.valid = false;
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    return true;
  }
  /** všechny clipy pod tímhle */
  all(): Clip[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  find(text: string): Clip | null {
    for (const c of this.all()) for (const ch of c.children) if (ch.text === text) return c;
    return null;
  }
  lines() {
    return this.all().reduce((n, c) => n + c.calls.filter((x) => x[0] === "lineTo").length, 0);
  }
}

export class Screen {
  static count = 0;
  id = ++Screen.count;
  ready = false;
  valid = true;
  root: Clip | null = null;
  handlers: Record<string, Fn[]> = {};
  calls = 0;
  mouse = { x: 0, y: 0 };
  mouseWorks = true;
  focused = false;
  visible = true;
  constructor(mouseWorks: boolean) {
    this.mouseWorks = mouseWorks;
    setTimeout(() => {
      this.ready = true;
      this.root = new Clip(this, null, "root");
      for (const f of this.handlers.ready ?? []) f();
    }, 30);
  }
  on(e: string, f: Fn) {
    (this.handlers[e] ??= []).push(f);
  }
  off() {}
  stage() {
    return { width: 1920, height: 1080 };
  }
  screenToStage(x: number, y: number) {
    return { x: x * 1920, y: y * 1080 };
  }
  focus() {
    this.focused = true;
    return true;
  }
  blur() {
    this.focused = false;
  }
  hasFocus() {
    return this.focused;
  }
  setVisible(v = true) {
    this.visible = v;
    return true;
  }
  close() {
    this.valid = false;
    return true;
  }
  input(action: string) {
    for (const f of this.handlers.input ?? []) f(action);
  }
}

export function makeClient(send: (name: string, payload: unknown) => void, opts: { scaleform?: boolean; mouse?: boolean; pos?: Vec; units?: number; script?: string } = {}) {
  const on = new Map<string, Fn[]>();
  const gizmos = new Map<string, { prim: any; style: any; units: number }>();
  let units = 0;
  const budget = opts.units ?? 16384;
  const screens: Screen[] = [];
  const views: { url: string; shown: boolean; focused: boolean; handlers: Map<string, Fn>; emitted: [string, any][] }[] = [];
  const shots: any[] = [];
  const notices: string[] = [];
  const books: any[] = [];
  const hints = new Map<number, { key: string; text: string; handler: Fn }>();
  const keys = new Map<string, Fn>();
  const logs: string[] = [];
  const exportsReg = new Map<string, unknown>();
  let hintSeq = 0;
  const controls = { off: 0 };
  const assets = new Set<string>(); // streamované soubory, které klient má
  const menus: [string, boolean][] = [];
  const cursorHolds = { n: 0 };
  const pose = {
    position: opts.pos ?? new Vec(0, 1.5, 1.6),
    forward: new Vec(0, 1, 0),
    right: new Vec(1, 0, 0),
    up: new Vec(0, 0, 1),
    fov: 55,
    aspectRatio: 16 / 9,
  };
  const ray = { dir: new Vec(0, 1, 0) };

  const costOf = (prim: any) =>
    prim.type === "polyline" ? prim.points.length - 1 + (prim.closed ? 1 : 0) : prim.type === "mesh" ? (prim.wireframe === false ? prim.indices.length : prim.indices.length * 2) : 12;

  const gizmoCalls = { set: 0, remove: 0 };
  const Gizmos = {
    set(id: string, prim: any, style: any = {}) {
      gizmoCalls.set++;
      if (!id || id.length > 128) throw new Error("id");
      if (prim.type === "polyline" && (prim.points.length < 2 || prim.points.length > 256)) throw new Error("polyline: 2 až 256 bodů");
      if (prim.type === "mesh" && (prim.points.length < 3 || prim.points.length > 1024 || prim.indices.length > 3072)) throw new Error("mesh");
      if (style.width !== undefined && (style.width < 0.5 || style.width > 8)) throw new Error("šířka 0,5 až 8");
      for (const p of prim.points ?? []) if (![p.x, p.y, p.z].every(Number.isFinite)) throw new Error("bod");
      const cost = costOf(prim);
      const old = gizmos.get(id);
      if (!old && gizmos.size >= 128) throw new Error("128 kreseb na resource");
      if (units - (old?.units ?? 0) + cost > budget) throw new Error("rozpočet Gizmos");
      units += cost - (old?.units ?? 0);
      gizmos.set(id, { prim, style, units: cost });
    },
    remove(id: string) {
      gizmoCalls.remove++;
      const g = gizmos.get(id);
      if (!g) return false;
      units -= g.units;
      gizmos.delete(id);
      return true;
    },
    clear() {
      gizmos.clear();
      units = 0;
    },
    setTransform: () => true,
  };

  const ctx = vm.createContext({
    Events: {
      on: (n: string, f: Fn) => (on.set(n, [...(on.get(n) ?? []), f]), () => {}),
      emitServer: (n: string, payload: unknown) => send(n, JSON.parse(JSON.stringify(payload ?? null))),
    },
    Camera: {
      getPose: () => pose,
      setShot: (o: any) => (shots.push(o), true),
      clearShot: () => void shots.push(null),
      screenRay: (o: any = {}) => ({ origin: pose.position, direction: ray.dir, target: new Vec() }),
    },
    Web: {
      getScreenSize: () => ({ width: 1920, height: 1080 }),
      createView: (url: string) => {
        views.push({ url, shown: false, focused: false, handlers: new Map(), emitted: [] });
        const viewId = views.length;
        setTimeout(() => (on.get("browserDocumentReady") ?? []).forEach((f) => f({ viewId })), 40);
        return viewId;
      },
      showView: (v: number) => ((views[v - 1].shown = true), true),
      hideView: (v: number) => ((views[v - 1].shown = false), true),
      focusView: (v: number, f = true) => ((views[v - 1].focused = f), true),
      on: (v: number, n: string, f: Fn) => void views[v - 1].handlers.set(n, f),
      emit: (v: number, n: string, p: any) => (views[v - 1].emitted.push([n, JSON.parse(JSON.stringify(p ?? null))]), true),
    },
    NativeUI: {
      setMenuEnabled: (menu: string, on: boolean) => void menus.push([menu, on]),
      createScreen: () => {
        if (opts.scaleform === false) throw new Error("Scaleform nejde");
        const s = new Screen(opts.mouse !== false);
        screens.push(s);
        return s;
      },
    },
    Hud: {
      worldToScreen: () => null,
      showNotification: (t: string) => (notices.push(t), true),
      showInfoText: (t: string) => (notices.push(t), true),
      hideInfoText: () => true,
      isInDialogue: () => false,
    },
    Gizmos,
    ActionHint: {
      create: (o: any, h: Fn) => (hints.set(++hintSeq, { ...o, handler: h }), hintSeq),
      setText: (id: number, t: string) => (hints.has(id) ? ((hints.get(id)!.text = t), true) : false),
      remove: (id: number) => hints.delete(id),
      keys: () => ["f", "use"],
    },
    Key: { bind: (k: string, ...a: any[]) => (keys.set(k, a.at(-1)), true), unbind: (k: string) => keys.delete(k), getLabel: (k: string) => k.toUpperCase() },
    Controls: { showCursor: () => void (cursorHolds.n++), hideCursor: () => void (cursorHolds.n--), disable: () => void (controls.off++), enable: () => void (controls.off--) },
    Assets: { has: (path: string) => assets.has(path) },
    Book: { open: (o: any) => (books.push(o), 1), getOpenBook: () => null, getLastError: () => "" },
    Exports: { register: (n: string, f: unknown) => (exportsReg.set(n, f), true) },
    Vector3: Vec,
    console: { log: (t: string) => void logs.push(String(t)) },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON, Math, Promise,
  });
  vm.runInContext(opts.script ?? read("dist/kresby/client.js"), ctx); // script: klient jiného resource (škola) nad stejným falešným API
  return {
    ctx,
    gizmos,
    gizmoCalls,
    units: () => units,
    screens,
    views,
    shots,
    notices,
    books,
    hints,
    keys,
    logs,
    exportsReg,
    pose,
    ray,
    deliver: (name: string, payload: unknown) => (on.get(name) ?? []).forEach((f) => f(payload)),
    stats: () => (exportsReg.get("stats") as Fn)(),
    cursor: () => cursorHolds.n,
    controls,
    assets,
    menus,
  };
}

export type FakeClient = ReturnType<typeof makeClient>;

/** server + klienti propojení přes "síť" (JSON); zpráva klienta jde na server asynchronně jako ve hře */
export function world(opts: Parameters<typeof makeServer>[0] & { clients?: Parameters<typeof makeClient>[1] } = {}) {
  const s = makeServer(opts);
  const clients = new Map<number, FakeClient>();
  for (const p of s.Player.list) {
    const c = makeClient((name, payload) => queueMicrotask(() => s.client(name, p, payload)), { ...opts.clients, pos: new Vec(p.position.x, p.position.y, p.position.z + 1.6) });
    clients.set(p.id, c);
    p.client = (name, payload) => c.deliver(name, payload);
  }
  return { s, c: (p: { id: number }) => clients.get(p.id)! };
}
