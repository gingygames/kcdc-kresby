// Podstavce listu (stojan): herní model a kde na něm leží líc. Změřeno z geometrie modelů hry (vrcholy .cgfm):
// každý model má přední stranu jinde, proto `yaw` = o kolik se model otočí navíc proti natočení líce.
// Líc s natočením θ (normalFromYaw) stojí na modelu natočeném o θ + yaw; pata modelu (jeho počátek) je od středu líce
// o `forward` za lícem (proti normále), `bok` vlevo (proti ose u listu) a `up` dolů.
//
//   sign_wall_board_rustic: dřevěná deska 1,33 × 0,78 m zavěšená na sloupku vlevo (x 0,05..1,37, z 0,83..1,62),
//                           přední strana −Y (deska je tenká na Y) → yaw 180, střed desky x 0,71, z 1,22
//   canvas_stand_a:         malířský stojan, přední strana +X (zepředu po +Y je vidět jen z boku) → yaw 90

import { axes, normalFromYaw, type V3 } from "./layout";

export interface Stojan {
  model: string;
  nazev: string;
  yaw: number; // stupně navíc k natočení líce (přední strana modelu)
  up: number; // m: střed líce nad patou
  forward: number; // m: líc před patou (po normále)
  bok: number; // m: střed líce vpravo od paty (po ose u listu)
  tilt: number; // stupně: líc skloněný dozadu
  sirka: number; // m: největší list
  vyska: number;
}

export const STOJANY: Stojan[] = [
  { model: "objects/manmade/common_decorations/streets_deco/sign_wall_board_rustic.cgf", nazev: "Dřevěná tabule na sloupku", yaw: 180, up: 1.225, forward: 0.03, bok: 0.711, tilt: 0, sirka: 1.05, vyska: 0.7 },
  { model: "objects/manmade/task_specific_props/painting/canvas_stand_a.cgf", nazev: "Malířský stojan", yaw: 90, up: 1.3, forward: 0.06, bok: 0, tilt: 12, sirka: 0.75, vyska: 0.5 },
];

export const VYCHOZI_STOJAN = STOJANY[0].model;

/** známý podstavec podle cesty modelu (velikost písmen nevadí), jinak null */
export const stojanPro = (model: string | null | undefined): Stojan | null => STOJANY.find((s) => s.model.toLowerCase() === String(model ?? "").toLowerCase()) ?? null;

/** líc na podstavci: pata modelu, natočení líce θ (stupně) -> střed líce a normála */
export function licStojanu(s: Pick<Stojan, "up" | "forward" | "bok" | "tilt">, pata: V3, yawLice: number): { pos: V3; n: V3 } {
  const n = normalFromYaw(yawLice, s.tilt);
  const u = axes(n).u;
  return { n, pos: [pata[0] + n[0] * s.forward + u[0] * s.bok, pata[1] + n[1] * s.forward + u[1] * s.bok, pata[2] + s.up] };
}

/** opak: kde stojí pata modelu, když je líc tady */
export function pataStojanu(s: Pick<Stojan, "up" | "forward" | "bok">, pos: V3, n: V3): V3 {
  const u = axes(n).u;
  return [pos[0] - n[0] * s.forward - u[0] * s.bok, pos[1] - n[1] * s.forward - u[1] * s.bok, pos[2] - s.up];
}
