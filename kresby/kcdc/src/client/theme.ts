// Vzhled nativního UI kreseb (Scaleform) na jednom místě: barvy jsou tokeny sdílené sady ui-kit/theme.css
// (--k-*; inkoust, pergamen, zlatý akcent), velikosti v jednotkách stage 1920 × 1080. HTML záloha plátna bere
// sadu přímo (ui/platno.html). Pozadí panelu je neprůhledné (pravidlo ui-kit: text nesmí plavat nad scénou).
export const T = {
  panel: 0x17130d, // --k-bg
  panelA: 100,
  surface: 0x211b12, // --k-surface
  edge: 0x54462d, // --k-line
  gold: 0xe0aa4a, // --k-accent
  goldInk: 0x1b1508, // --k-accent-ink
  text: 0xf1e8d3, // --k-text
  dim: 0xc0b498, // --k-muted
  faint: 0x9a8e74, // --k-faint (jen dekorace a vypnuté prvky)
  btn: 0x2c2418, // --k-surface-2
  btnOn: 0x372d1e, // --k-raised
  ok: 0x9ad586, // --k-ok
  warn: 0xefc562, // --k-warn
  bad: 0xf49b8c, // --k-err
  second: 0x93c8ea, // --k-info
  paper: 0xefe3c4, // --k-paper
  paperText: 0x2b2113, // --k-paper-text
  font: "DefaultFont",
  title: "Manuscript",
  small: 15,
  body: 18,
  big: 22,
};
