/** How dates are written in a source, and reading them as yyyy-mm-dd (shared by the mapping and the steps). */
export const DATE_FORMATS = ['iso', 'dmy', 'mdy', 'excel'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (y: number, m: number, d: number): string | null => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};

/** A date written in the given way, as yyyy-mm-dd (null when it is not a real date). */
export function parseDate(raw: string, format: DateFormat = 'iso'): string | null {
  const s = raw.trim();
  if (format === 'excel' || /^\d{5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return new Date(Math.round((n - 25569) * 86_400_000)).toISOString().slice(0, 10);
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (!m || format === 'iso') return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return format === 'dmy' ? isoDate(year, +m[2], +m[1]) : isoDate(year, +m[1], +m[2]);
}

