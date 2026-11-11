import {
  addDays,
  addMonths,
  addYears,
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  endOfYear,
  startOfDay,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  subDays,
} from "date-fns";

/**
 * Ready-made presets for the date picker (`presets` prop of RHFDatePicker / RHFDatePickerPopout).
 *
 * A preset is `{ key?, label, range: (today) => [from, to] }` for a range picker, or `{ key?, label, date: (today) => Date }`
 * for a single-date picker. Each instance of the picker chooses its own list: pass built-in keys, your own objects, or a mix —
 *
 *   presets={["thisMonth", "lastMonth", { label: "Last 45 days", range: (t) => [subDays(t, 44), t] }]}
 *   presets="ranges"            // every built-in range preset
 *   presets="dates"             // every built-in single-date preset
 *
 * `weekStartsOn` is Monday (1) throughout, like the calendar.
 */
const WEEK = { weekStartsOn: 1 };

export const RANGE_PRESETS = {
  today: { label: "Today", range: (t) => [startOfDay(t), startOfDay(t)] },
  yesterday: { label: "Yesterday", range: (t) => [startOfDay(subDays(t, 1)), startOfDay(subDays(t, 1))] },
  last7: { label: "Last 7 days", range: (t) => [startOfDay(subDays(t, 6)), startOfDay(t)] },
  last30: { label: "Last 30 days", range: (t) => [startOfDay(subDays(t, 29)), startOfDay(t)] },
  last90: { label: "Last 90 days", range: (t) => [startOfDay(subDays(t, 89)), startOfDay(t)] },
  thisWeek: { label: "This week", range: (t) => [startOfWeek(t, WEEK), startOfDay(endOfWeek(t, WEEK))] },
  lastWeek: {
    label: "Last week",
    range: (t) => {
      const d = subDays(t, 7);
      return [startOfWeek(d, WEEK), startOfDay(endOfWeek(d, WEEK))];
    },
  },
  thisMonth: { label: "This month", range: (t) => [startOfMonth(t), startOfDay(endOfMonth(t))] },
  lastMonth: {
    label: "Last month",
    range: (t) => {
      const d = addMonths(t, -1);
      return [startOfMonth(d), startOfDay(endOfMonth(d))];
    },
  },
  thisQuarter: { label: "This quarter", range: (t) => [startOfQuarter(t), startOfDay(endOfQuarter(t))] },
  lastQuarter: {
    label: "Last quarter",
    range: (t) => {
      const d = addMonths(t, -3);
      return [startOfQuarter(d), startOfDay(endOfQuarter(d))];
    },
  },
  thisYear: { label: "This year", range: (t) => [startOfYear(t), startOfDay(endOfYear(t))] },
  lastYear: {
    label: "Last year",
    range: (t) => {
      const d = addYears(t, -1);
      return [startOfYear(d), startOfDay(endOfYear(d))];
    },
  },
};

export const DATE_PRESETS = {
  today: { label: "Today", date: (t) => startOfDay(t) },
  tomorrow: { label: "Tomorrow", date: (t) => startOfDay(addDays(t, 1)) },
  yesterday: { label: "Yesterday", date: (t) => startOfDay(subDays(t, 1)) },
  nextWeek: { label: "In a week", date: (t) => startOfDay(addDays(t, 7)) },
  nextMonth: { label: "In a month", date: (t) => startOfDay(addMonths(t, 1)) },
  endOfMonth: { label: "End of this month", date: (t) => startOfDay(endOfMonth(t)) },
  endOfYear: { label: "End of this year", date: (t) => startOfDay(endOfYear(t)) },
};

/** What a picker shows when `presets` is `true`. */
export const DEFAULT_RANGE_PRESETS = ["thisMonth", "lastMonth", "thisQuarter", "lastQuarter", "thisYear", "lastYear", "last7", "last30"];
export const DEFAULT_DATE_PRESETS = ["today", "tomorrow", "yesterday", "nextWeek", "nextMonth"];

/**
 * Turns the `presets` prop into a list of `{ key, label, range | date }` for `mode` ("single" | "range"). Unknown keys are
 * skipped, objects without a label or without the function their mode needs are skipped, nothing is returned for a falsy value.
 */
export const resolvePresets = (presets, mode = "single") => {
  if (!presets) return [];
  const range = mode === "range";
  const table = range ? RANGE_PRESETS : DATE_PRESETS;
  let list = presets;
  if (presets === true) list = range ? DEFAULT_RANGE_PRESETS : DEFAULT_DATE_PRESETS;
  else if (presets === "ranges") list = Object.keys(RANGE_PRESETS);
  else if (presets === "dates") list = Object.keys(DATE_PRESETS);
  if (!Array.isArray(list)) return [];
  return list
    .map((p, i) => {
      if (typeof p === "string") return table[p] ? { key: p, ...table[p] } : null;
      if (!p || typeof p !== "object" || !p.label) return null;
      if (range ? typeof p.range !== "function" : typeof p.date !== "function") return null;
      return { key: p.key ?? `custom-${i}`, ...p };
    })
    .filter(Boolean);
};

/**
 * Keeps a range inside what the picker allows (`min` / `max` are Dates or null). Returns null when nothing of it is allowed,
 * so the picker can switch that preset off instead of picking days the calendar would refuse.
 */
export const clampRange = ([from, to], min, max) => {
  let a = startOfDay(from);
  let b = startOfDay(to);
  if (min && a < startOfDay(min)) a = startOfDay(min);
  if (max && b > startOfDay(max)) b = startOfDay(max);
  return a > b ? null : [a, b];
};
