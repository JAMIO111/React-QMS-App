/**
 * Expiry of a certification or document, worked out when it is read (there is no worker) and never acted on: an expired certificate is a warning and a
 * watchlist item, it does not change a supplier's approval status.
 */
export const EXPIRY_WARNING_DAYS = 60;

export type ExpiryState = 'no_expiry' | 'valid' | 'expiring' | 'expired';
export interface Expiry {
  state: ExpiryState;
  /** Whole days until the last valid day (negative once expired, 0 on the last day); null without an expiry date. */
  daysLeft: number | null;
}

const DAY = 86400000;
const utcDay = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
};

/** `expiresOn` and `today` are date-only strings (2026-11-30). A certificate is valid through its expiry date and expired the day after. */
export const expiryOf = (expiresOn: string | null | undefined, today: string, warnDays = EXPIRY_WARNING_DAYS): Expiry => {
  if (!expiresOn) return { state: 'no_expiry', daysLeft: null };
  const daysLeft = Math.round((utcDay(expiresOn) - utcDay(today)) / DAY);
  if (daysLeft < 0) return { state: 'expired', daysLeft };
  return { state: daysLeft <= warnDays ? 'expiring' : 'valid', daysLeft };
};

export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);
