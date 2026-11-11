/**
 * Dates as the person sees them. `new Date().toISOString().slice(0, 10)` is the date in UTC, which is yesterday or tomorrow for part of every day for anyone
 * away from UTC (a person in India at 02:00 is still on the previous UTC date, and a form "not in the future" check then refuses today). These helpers use
 * the browser's own calendar day, which is also the day the API is told to use (`X-Time-Zone`, see api-client.js).
 */
const two = (n) => String(n).padStart(2, "0");

/** yyyy-MM-dd of a Date in the browser's time zone. */
export const localDay = (date = new Date()) => `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;

/** Today (or today plus `days`, which may be negative) as yyyy-MM-dd in the browser's time zone. */
export const todayIso = (days = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDay(d);
};

/** yyyy-MM of today in the browser's time zone. */
export const thisMonthIso = () => todayIso().slice(0, 7);
