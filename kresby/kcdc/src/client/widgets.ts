// Ovládací prvky nativního UI kreseb (Scaleform přes kreslicí API clipu): tlačítko s ikonou a klávesou, posuvník.
import { Pen, text } from "./native";
import { T } from "./theme";

export type BtnState = "off" | "on" | "dis";

export interface Btn {
  clip: NativeClip;
  set(st: BtnState): void;
  label(t: string): void;
}

/** tlačítko: rámeček, popisek, volitelně ikona (kreslí se do horní části) a klávesa v rohu */
export function btn(parent: NativeClip, x: number, y: number, w: number, h: number, label: string, onPress: () => void, o: { key?: string; icon?: (p: Pen, w: number, h: number) => void; size?: number; strong?: boolean } = {}): Btn {
  const c = parent.createClip()!;
  c.set({ x, y });
  const pen = new Pen(c);
  const iconClip = o.icon ? c.createClip() : null;
  const size = o.size ?? T.body;
  // klávesa: u ikony v rohu, jinak malým písmem pod popiskem
  const below = !!o.key && !o.icon;
  const ty = o.icon ? h - size * 1.45 : below ? (h - size * 1.3 - 14) / 2 : (h - size * 1.3) / 2;
  const t = text(c, 0, ty, w, size * 1.5, label, size, T.text, T.font);
  t?.setTextStyle({ align: "center" });
  const k = o.key ? (below ? text(c, 0, h - 19, w, 18, o.key, 12, T.dim, T.font) : text(c, 4, 2, 40, 18, o.key, 13, T.dim, T.font)) : null;
  if (below) k?.setTextStyle({ align: "center" });
  let state: BtnState = "off";
  const draw = () => {
    pen.clear();
    const on = state === "on";
    // hlavní tlačítko (jedno na místo) zlaté s tmavým písmem, ostatní tmavé; vypnuté bledé
    const gold = o.strong && state !== "dis";
    pen.rect(0, 0, w, h, gold ? T.gold : on ? T.btnOn : T.btn, state === "dis" ? 60 : 100);
    pen.frame(0, 0, w, h, on ? 2.5 : 1.5, on || gold ? T.gold : T.edge, state === "dis" ? 50 : 100);
    t?.setTextStyle({ color: state === "dis" ? T.faint : gold ? T.goldInk : T.text });
    k?.setTextStyle({ color: gold ? T.goldInk : on ? T.gold : T.dim });
    if (iconClip) {
      iconClip.set({ alpha: state === "dis" ? 0.35 : 1 });
      const ip = new Pen(iconClip);
      ip.clear();
      o.icon!(ip, w, h - size * 1.5);
    }
  };
  draw();
  c.on("press", () => state !== "dis" && onPress());
  return {
    clip: c,
    set(st) {
      if (st === state) return;
      state = st;
      draw();
    },
    label(s) {
      t?.setText(s);
    },
  };
}

export interface Slider {
  set(v: number): void;
  visible(on: boolean): void;
  stop(): void;
}

/** posuvník 0..1: popisek nad ním, tažení myší (čte _xmouse po 25 ms) */
export function slider(parent: NativeClip, x: number, y: number, w: number, label: string, value: number, show: (v: number) => string, onChange: (v: number) => void): Slider {
  const c = parent.createClip()!;
  c.set({ x, y });
  const caption = text(c, 0, -24, w, 22, label, T.small, T.dim, T.font);
  const pen = new Pen(c);
  let v = value;
  let drag: number | null = null;
  const draw = () => {
    pen.clear();
    pen.rect(-4, -2, w + 8, 24, 0x000000, 1); // větší plocha pro klik
    pen.rect(0, 7, w, 6, T.btn, 95);
    pen.rect(0, 7, w * v, 6, T.edge, 100);
    pen.circle(w * v, 10, 8, T.gold, 100);
    caption?.setText(label + ": " + show(v));
  };
  draw();
  const read = () => {
    const mx = Number(c.get("_xmouse"));
    if (!Number.isFinite(mx)) return;
    const nv = Math.max(0, Math.min(1, mx / w));
    if (Math.abs(nv - v) > 0.002) {
      v = nv;
      draw();
      onChange(v);
    }
  };
  const stop = () => {
    if (drag !== null) clearInterval(drag);
    drag = null;
  };
  c.on("press", () => {
    read();
    stop();
    drag = setInterval(read, 25);
  });
  c.on("release", stop);
  c.on("releaseOutside", stop);
  return {
    set(nv) {
      v = Math.max(0, Math.min(1, nv));
      draw();
    },
    visible(on) {
      c.set({ visible: on });
    },
    stop,
  };
}

// ikony nástrojů (čáry ve stylu kresby, do obdélníku w × h)
export const ICONS: ((p: Pen, w: number, h: number) => void)[] = [
  // brk: pero šikmo, hrot vlevo dole
  (p, w, h) => {
    p.line(2, T.text, 100);
    p.move(w * 0.3, h * 0.82);
    p.to(w * 0.72, h * 0.22);
    p.line(5, T.text, 85);
    p.move(w * 0.55, h * 0.45);
    p.to(w * 0.78, h * 0.14);
    p.circle(w * 0.3, h * 0.82, 2, T.gold, 100);
  },
  // štětec: násada a široká stopa
  (p, w, h) => {
    p.line(3, T.dim, 100);
    p.move(w * 0.62, h * 0.18);
    p.to(w * 0.45, h * 0.5);
    p.line(11, T.text, 90);
    p.move(w * 0.42, h * 0.56);
    p.to(w * 0.3, h * 0.78);
  },
  // uhel: hrubý kousek a zrnitá čára
  (p, w, h) => {
    p.rect(w * 0.55, h * 0.18, w * 0.16, h * 0.32, 0x5a5652, 100);
    p.line(4, 0x8a8580, 70);
    p.move(w * 0.25, h * 0.8);
    p.to(w * 0.45, h * 0.62);
    p.to(w * 0.55, h * 0.66);
  },
  // škrabka: čepel
  (p, w, h) => {
    p.rect(w * 0.3, h * 0.55, w * 0.4, h * 0.14, 0xc8c8c0, 100);
    p.line(3, T.dim, 100);
    p.move(w * 0.5, h * 0.55);
    p.to(w * 0.5, h * 0.18);
  },
];

/** zámeček (zamčený inkoust) */
export function lock(p: Pen, cx: number, cy: number, s: number) {
  p.rect(cx - s * 0.5, cy - s * 0.1, s, s * 0.7, T.text, 95);
  p.line(Math.max(1.5, s * 0.14), T.text, 95);
  p.move(cx - s * 0.3, cy - s * 0.1);
  p.to(cx - s * 0.3, cy - s * 0.4);
  p.to(cx + s * 0.3, cy - s * 0.4);
  p.to(cx + s * 0.3, cy - s * 0.1);
}
