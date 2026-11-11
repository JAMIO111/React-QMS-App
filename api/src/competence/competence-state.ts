/** Competence figures worked out on read (never stored): expiry and gap. Information only; nothing here changes a level. */
export const EXPIRY_WARNING_DAYS = 60;

export type ExpiryState = 'none' | 'valid' | 'expiring' | 'expired';
export type CellStatus = 'not_assessed' | 'gap' | 'expired' | 'expiring' | 'ok' | 'extra';

const DAY = 86_400_000;
const dayNumber = (isoDay: string) => Math.floor(Date.parse(`${isoDay}T00:00:00Z`) / DAY);

/** Days from `today` to `expiresOn` (negative once past); both yyyy-MM-dd. */
export const daysUntil = (expiresOn: string, today: string) => dayNumber(expiresOn) - dayNumber(today);

/** Valid through the expiry date itself, like certifications. */
export function expiryState(expiresOn: string | null | undefined, today: string, warnDays = EXPIRY_WARNING_DAYS): ExpiryState {
  if (!expiresOn) return 'none';
  const d = daysUntil(expiresOn, today);
  if (d < 0) return 'expired';
  return d <= warnDays ? 'expiring' : 'valid';
}

export interface CellInput {
  level: number | null;
  required: number | null;
  expiresOn: string | null;
}

/**
 * What a person's standing in one skill needs attention for. The order says what matters most: a missing or short level (gap) first, then an expired
 * assessment, then one expiring. A skill nobody requires of them is "extra" (they hold it anyway) and is never a problem. A level is never lowered by expiry.
 */
export function cellStatus(c: CellInput, today: string): { status: CellStatus; gap: number; expiry: ExpiryState } {
  const expiry = c.level === null ? 'none' : expiryState(c.expiresOn, today);
  const required = c.required ?? 0;
  const gap = Math.max(0, required - (c.level ?? 0));
  if (c.required === null) return { status: c.level === null ? 'not_assessed' : 'extra', gap: 0, expiry };
  if (c.level === null) return { status: 'not_assessed', gap, expiry };
  if (gap > 0) return { status: 'gap', gap, expiry };
  if (expiry === 'expired') return { status: 'expired', gap: 0, expiry };
  if (expiry === 'expiring') return { status: 'expiring', gap: 0, expiry };
  return { status: 'ok', gap: 0, expiry };
}
