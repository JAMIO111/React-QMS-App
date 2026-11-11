import { addDays, differenceInCalendarDays, format, isValid, parseISO, startOfDay, startOfMonth, startOfQuarter, startOfYear, subDays, subMonths } from "date-fns";

/**
 * The period every dashboard shows: one of these presets (the `?period=` id in the address, so older links still work) or a
 * custom range (`?from=yyyy-MM-dd&to=yyyy-MM-dd`). Ranges never run past today; the dashboard APIs accept at most three years.
 */
export const MAX_PERIOD_DAYS = 3 * 366;

const upToToday = (from) => (t) => [from(t), startOfDay(t)];
export const DASHBOARD_PERIODS = [
  { id: "thisMonth", label: "This month", range: upToToday((t) => startOfMonth(t)) },
  { id: "lastMonth", label: "Last month", range: (t) => { const s = startOfMonth(subMonths(t, 1)); return [s, subDays(startOfMonth(t), 1)]; } },
  { id: "thisQuarter", label: "This quarter", range: upToToday((t) => startOfQuarter(t)) },
  { id: "lastQuarter", label: "Last quarter", range: (t) => { const s = startOfQuarter(subMonths(t, 3)); return [s, subDays(startOfQuarter(t), 1)]; } },
  { id: "ytd", label: "This year", range: upToToday((t) => startOfYear(t)) },
  { id: "lastYear", label: "Last year", range: (t) => { const s = startOfYear(subMonths(startOfYear(t), 1)); return [s, subDays(startOfYear(t), 1)]; } },
  { id: "30d", label: "Last 30 days", range: upToToday((t) => subDays(t, 29)) },
  { id: "90d", label: "Last 90 days", range: upToToday((t) => subDays(t, 89)) },
  { id: "12m", label: "Last 12 months", range: upToToday((t) => addDays(subMonths(t, 12), 1)) },
  { id: "24m", label: "Last 24 months", range: upToToday((t) => addDays(subMonths(t, 24), 1)) },
];

const ISO = "yyyy-MM-dd";
const readIso = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = parseISO(value);
  return isValid(d) ? startOfDay(d) : null;
};

/**
 * Works out the period from the address. A valid custom range wins, then a known `period` id, then `defaultId`.
 * Returns { id ("custom" for a range), label, from, to (Dates), fromIso, toIso }.
 */
export const readPeriod = (params, defaultId, today = new Date()) => {
  const t = startOfDay(today);
  const from = readIso(params.get("from"));
  const to = readIso(params.get("to"));
  if (from && to && from <= to && to <= t && differenceInCalendarDays(to, from) <= MAX_PERIOD_DAYS) {
    return { id: "custom", label: null, from, to, fromIso: format(from, ISO), toIso: format(to, ISO) };
  }
  const preset = DASHBOARD_PERIODS.find((p) => p.id === params.get("period")) ?? DASHBOARD_PERIODS.find((p) => p.id === defaultId) ?? DASHBOARD_PERIODS[0];
  const [a, b] = preset.range(t);
  return { id: preset.id, label: preset.label, from: a, to: b, fromIso: format(a, ISO), toIso: format(b, ISO) };
};

/** The address parameters for a picked range: a preset's id when it is exactly one, else from and to; nothing for the default. */
export const periodParams = ({ from, to }, defaultId, today = new Date()) => {
  const t = startOfDay(today);
  const f = startOfDay(from);
  const e = startOfDay(to);
  const match = DASHBOARD_PERIODS.find((p) => {
    const [a, b] = p.range(t);
    return a.getTime() === f.getTime() && b.getTime() === e.getTime();
  });
  if (match) return match.id === defaultId ? {} : { period: match.id };
  return { from: format(f, ISO), to: format(e, ISO) };
};
