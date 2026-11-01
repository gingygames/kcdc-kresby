// Model listu (CryEngine CGF + CGFM, jako modely KCD2) a jeho materiál (.mtl).
//
// Hra rozděluje statický model na `x.cgf` (uzel, materiál, prázdná síť) a `x.cgfm` (síť: podmnožiny, proudy vrcholů,
// indexů a tečen). Formát je zjištěný z modelu listu hry (Objects/.../scrolls/paper_a.cgf), píšeme vlastní geometrii:
// obdélník 1 × 2/3 m (poměr listu 3 : 2), líc k +Z, u zleva doprava po +X, v shora dolů po −Y. Materiál je cesta bez
// přípony (`objects/kcdc/<resource>/k12`), hra ho najde jako `<cesta>.mtl` ve streamovaných souborech.

const CH = {
  mesh: 0x1000,
  node: 0x100b,
  timing: 0x100e,
  sourceInfo: 0x1013,
  mtlName: 0x1014,
  exportFlags: 0x1015,
  stream: 0x1016,
  subsets: 0x1017,
};
const STREAM = { indices: 5, tangents: 6, p3s_c4b_t2s: 15 };

export const SHEET_W = 1;
export const SHEET_H = 2 / 3;

interface Chunk {
  type: number;
  ver: number;
  id: number;
  data: Uint8Array;
}

function file(chunks: Chunk[]): Uint8Array {
  const tableOff = 16;
  let off = tableOff + chunks.length * 16;
  const offs: number[] = [];
  for (const c of chunks) {
    offs.push(off);
    off += (c.data.length + 3) & ~3;
  }
  const out = new Uint8Array(off);
  const v = new DataView(out.buffer);
  out.set([0x43, 0x72, 0x43, 0x68], 0); // "CrCh"
  v.setUint32(4, 0x746, true);
  v.setUint32(8, chunks.length, true);
  v.setUint32(12, tableOff, true);
  chunks.forEach((c, i) => {
    const t = tableOff + i * 16;
    v.setUint16(t, c.type, true);
    v.setUint16(t + 2, c.ver, true);
    v.setUint32(t + 4, c.id, true);
    v.setUint32(t + 8, c.data.length, true);
    v.setUint32(t + 12, offs[i], true);
    out.set(c.data, offs[i]);
  });
  return out;
}

// cesty a jména v CGF jsou ASCII
const enc = { encode: (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0x7f) };
function str(b: Uint8Array, o: number, s: string, max: number) {
  const x = enc.encode(s);
  b.set(x.subarray(0, max - 1), o);
}

function mtlName(path: string): Uint8Array {
  const sub = "kresba";
  const b = new Uint8Array(128 + 4 + 4 + sub.length + 1);
  const v = new DataView(b.buffer);
  str(b, 0, path, 128);
  v.setInt32(128, 1, true); // podmateriálů
  v.setInt32(132, -1, true); // bez fyziky
  str(b, 136, sub, sub.length + 1);
  return b;
}

function node(name: string, objectId: number, mtlId: number): Uint8Array {
  const b = new Uint8Array(204);
  const v = new DataView(b.buffer);
  str(b, 0, name, 64);
  v.setInt32(64, objectId, true);
  v.setInt32(68, -1, true); // bez rodiče
  v.setInt32(72, 0, true); // bez dětí
  v.setInt32(76, mtlId, true);
  v.setInt32(80, 0, true);
  for (let i = 0; i < 4; i++) v.setFloat32(84 + (i * 5) * 4, 1, true); // jednotková matice
  for (let i = 0; i < 3; i++) v.setInt32(188 + i * 4, -1, true); // bez kontrolérů
  v.setInt32(200, 0, true); // délka vlastností
  return b;
}

interface Geo {
  pos: number[]; // x y z
  uv: number[];
  idx: number[];
}

// rub: druhý obdélník těsně za lícem, otočený dozadu, celý s barvou okraje papíru (texel u rohu kresby): zezadu je
// vidět čistý rub listu, ne zrcadlená kresba (materiál je jednostranný)
const RUB_UV = 0.01;
const RUB_Z = -0.0015;
export const RUB_VRCHOLU = 4;

function quad(): Geo {
  const w = SHEET_W / 2;
  const h = SHEET_H / 2;
  return {
    pos: [-w, -h, 0, w, -h, 0, w, h, 0, -w, h, 0, -w, -h, RUB_Z, w, -h, RUB_Z, w, h, RUB_Z, -w, h, RUB_Z],
    uv: [0, 1, 1, 1, 1, 0, 0, 0, ...Array.from({ length: 8 }, () => RUB_UV)],
    // líc proti směru hodinových ručiček při pohledu z +Z (jako paper_a), rub obráceně (vidět z −Z)
    idx: [0, 1, 2, 2, 3, 0, 4, 6, 5, 6, 4, 7],
  };
}

function half(x: number): number {
  const f = new Float32Array([x]);
  const i = new Uint32Array(f.buffer)[0];
  const s = (i >>> 16) & 0x8000;
  let e = ((i >>> 23) & 0xff) - 127 + 15;
  let m = (i >>> 13) & 0x3ff;
  if (e <= 0) return s; // denormál/nula
  if (e >= 31) return s | 0x7c00;
  if ((i >>> 12) & 1) {
    m++;
    if (m > 0x3ff) {
      m = 0;
      e++;
    }
  }
  return s | (e << 10) | m;
}

function stream(type: number, count: number, elem: number, data: Uint8Array): Uint8Array {
  const b = new Uint8Array(24 + data.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0, true);
  v.setUint32(4, type, true);
  v.setUint32(8, count, true);
  v.setUint32(12, elem, true);
  b.set(data, 24);
  return b;
}

function bbox(g: Geo) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.pos.length; i += 3) for (let k = 0; k < 3; k++) (mn[k] = Math.min(mn[k], g.pos[i + k])), (mx[k] = Math.max(mx[k], g.pos[i + k]));
  return { mn, mx };
}

function meshChunk(g: Geo, empty: boolean, subsetsId: number, streams: Record<number, number>): Uint8Array {
  const b = new Uint8Array(264);
  const v = new DataView(b.buffer);
  const nv = g.pos.length / 3;
  v.setInt32(0, empty ? 0x0b : 0x0a, true); // (prázdná) | hustota mapování | plocha stěn
  v.setInt32(8, nv, true);
  v.setInt32(12, g.idx.length, true);
  v.setInt32(16, 1, true);
  v.setInt32(20, empty ? 0 : subsetsId, true);
  if (!empty) for (const [t, id] of Object.entries(streams)) v.setInt32(28 + Number(t) * 4, id, true);
  const { mn, mx } = bbox(g);
  for (let k = 0; k < 3; k++) {
    v.setFloat32(108 + k * 4, mn[k], true);
    v.setFloat32(120 + k * 4, mx[k], true);
  }
  const area = SHEET_W * SHEET_H;
  v.setFloat32(132, 1 / area, true); // hustota mapování: plocha UV / plocha ve světě
  v.setFloat32(136, area / (g.idx.length / 3), true); // průměrná plocha stěny
  return b;
}

function subsets(g: Geo): Uint8Array {
  const b = new Uint8Array(56);
  const v = new DataView(b.buffer);
  v.setInt32(0, 4, true);
  v.setInt32(4, 1, true);
  v.setInt32(16, 0, true);
  v.setInt32(20, g.idx.length, true);
  v.setInt32(24, 0, true);
  v.setInt32(28, g.pos.length / 3, true);
  v.setInt32(32, 0, true);
  v.setFloat32(36, Math.hypot(SHEET_W, SHEET_H) / 2, true);
  v.setFloat32(52, 1 / (SHEET_W * SHEET_H), true);
  return b;
}

/** model listu s daným materiálem: { cgf, cgfm } */
export function sheetModel(materialPath: string): { cgf: Uint8Array; cgfm: Uint8Array } {
  const g = quad();
  const nv = g.pos.length / 3;
  const verts = new Uint8Array(nv * 16);
  const vv = new DataView(verts.buffer);
  for (let i = 0; i < nv; i++) {
    const o = i * 16;
    vv.setUint16(o, half(g.pos[i * 3]), true);
    vv.setUint16(o + 2, half(g.pos[i * 3 + 1]), true);
    vv.setUint16(o + 4, half(g.pos[i * 3 + 2]), true);
    vv.setUint16(o + 6, half(1), true);
    vv.setUint32(o + 8, 0xffffffff, true); // barva vrcholu
    vv.setUint16(o + 12, half(g.uv[i * 2]), true);
    vv.setUint16(o + 14, half(g.uv[i * 2 + 1]), true);
  }
  const idx = new Uint8Array(g.idx.length * 2);
  g.idx.forEach((x, i) => new DataView(idx.buffer).setUint16(i * 2, x, true));
  // tečna = +X (roste u), bitečna = −Y (roste v), znaménko −1: normála = +Z (jako paper_a); rub znaménko +1: normála −Z
  const tan = new Uint8Array(nv * 16);
  const tv = new DataView(tan.buffer);
  for (let i = 0; i < nv; i++) {
    const o = i * 16;
    const rub = i >= nv - RUB_VRCHOLU;
    tv.setInt16(o, 32767, true);
    tv.setInt16(o + 6, rub ? 32767 : -32767, true);
    tv.setInt16(o + 10, -32767, true);
    tv.setInt16(o + 14, rub ? 32767 : -32767, true);
  }
  const mtl = mtlName(materialPath);
  const cgfm = file([
    { type: CH.mtlName, ver: 0x802, id: 1, data: mtl },
    { type: CH.subsets, ver: 0x800, id: 2, data: subsets(g) },
    { type: CH.stream, ver: 0x800, id: 3, data: stream(STREAM.p3s_c4b_t2s, nv, 16, verts) },
    { type: CH.stream, ver: 0x800, id: 4, data: stream(STREAM.indices, g.idx.length, 2, idx) },
    { type: CH.stream, ver: 0x800, id: 5, data: stream(STREAM.tangents, nv, 16, tan) },
    { type: CH.mesh, ver: 0x801, id: 6, data: meshChunk(g, false, 2, { [STREAM.p3s_c4b_t2s]: 3, [STREAM.indices]: 4, [STREAM.tangents]: 5 }) },
    { type: CH.node, ver: 0x824, id: 7, data: node("kresby_list", 6, 1) },
  ]);
  const src = enc.encode("kresby\u0000" + new Date(0).toUTCString() + "\u0000kresby@kcdmp\u0000");
  const timing = new Uint8Array(52);
  const tmv = new DataView(timing.buffer);
  tmv.setFloat32(0, 1 / 4800, true);
  tmv.setInt32(4, 160, true);
  str(timing, 8, "GlobalRange", 32);
  tmv.setInt32(44, 100, true);
  const flags = new Uint8Array(164);
  const fv = new DataView(flags.buffer);
  [6, 8, 1, 1].forEach((x, i) => fv.setInt32(4 + i * 4, x, true));
  str(flags, 20, " RCVer:1.8 ", 16);
  const cgf = file([
    { type: CH.sourceInfo, ver: 0, id: 0, data: src },
    { type: CH.timing, ver: 0x918, id: 2, data: timing },
    { type: CH.exportFlags, ver: 0x1, id: 3, data: flags },
    { type: CH.mtlName, ver: 0x802, id: 4, data: mtl },
    { type: CH.mesh, ver: 0x801, id: 5, data: meshChunk(g, true, 0, {}) },
    { type: CH.node, ver: 0x824, id: 6, data: node("kresby_list", 5, 4) },
  ]);
  return { cgf, cgfm };
}

/** materiál listu: Illum, jednostranný (rub má vlastní stěny), matný papír, difuzní textura kresby (cesta s příponou .dds) */
export function sheetMaterial(texturePath: string, opts: { shininess?: number; specular?: number } = {}): string {
  const sh = opts.shininess ?? 30;
  const sp = opts.specular ?? 0.02;
  return `<?xml version="1.0" encoding="us-ascii"?>
<Material MtlFlags="524544" vertModifType="0">
	<SubMaterials>
		<Material AlphaTest="0" Diffuse="1,1,1" LayerAct="1" MatTemplate="" MtlFlags="524416" Name="kresba" Opacity="1" Shader="Illum" Shininess="${sh}" Specular="${sp},${sp},${sp}" StringGenMask="" SurfaceType="mat_fabric" vertModifType="0">
			<Textures>
				<Texture File="${texturePath}" Map="Diffuse" />
			</Textures>
			<PublicParams EmittanceMapGamma="1" SSSIndex="0" />
		</Material>
	</SubMaterials>
	<PublicParams EmittanceMapGamma="1" SSSIndex="0" />
</Material>
`;
}
