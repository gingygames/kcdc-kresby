// Filtr popisků kreseb (název, podpis): jiný resource (škola: gramotnost postavy) si ho zaregistruje exportem
// setCaptionFilter na serveru i v klientu. Kresby na něm nezávisí (žádná závislost v manifestu, žádný cyklus):
// bez filtru, nebo když vlastník skončí, jsou popisky beze změny.

type Filtr = (...a: any[]) => unknown;
let filtr: Filtr | null = null;
let vlastnik: string | null = null;

/** fn(pid, text, seed) na serveru, fn(text, seed) v klientu; null = zrušit */
export function setCaptionFilter(fn: Filtr | null, owner: string): boolean {
  filtr = typeof fn === "function" ? fn : null;
  vlastnik = filtr ? String(owner ?? "") : null;
  return !!filtr;
}

export function captionOwnerStopped(name: string) {
  if (vlastnik && name === vlastnik) (filtr = null), (vlastnik = null);
}

/** text přes filtr (args = [pid,] text, seed); chyba filtru = text beze změny */
export function caption(text: string, ...args: unknown[]): string {
  if (!text || !filtr) return text;
  try {
    const r = filtr(...args);
    return typeof r === "string" && [...r].length === [...text].length ? r : text;
  } catch {
    return text;
  }
}
