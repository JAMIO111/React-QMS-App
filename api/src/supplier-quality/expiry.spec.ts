import { expiryOf, EXPIRY_WARNING_DAYS } from './expiry';

describe('expiryOf', () => {
  const today = '2026-11-09';
  it('has no state without an expiry date', () => {
    expect(expiryOf(null, today)).toEqual({ state: 'no_expiry', daysLeft: null });
    expect(expiryOf(undefined, today)).toEqual({ state: 'no_expiry', daysLeft: null });
  });
  it('is valid through its last day and expired the day after', () => {
    expect(expiryOf('2026-11-09', today)).toEqual({ state: 'expiring', daysLeft: 0 });
    expect(expiryOf('2026-11-08', today)).toEqual({ state: 'expired', daysLeft: -1 });
  });
  it('is expiring inside the warning window and valid outside it', () => {
    expect(expiryOf('2027-01-08', today)).toEqual({ state: 'expiring', daysLeft: EXPIRY_WARNING_DAYS });
    expect(expiryOf('2027-01-09', today)).toEqual({ state: 'valid', daysLeft: EXPIRY_WARNING_DAYS + 1 });
  });
  it('counts across month, year and leap-day boundaries', () => {
    expect(expiryOf('2028-03-01', '2028-02-28').daysLeft).toBe(2);
    expect(expiryOf('2027-01-01', '2026-12-31').daysLeft).toBe(1);
  });
  it('takes the warning window as a parameter', () => {
    expect(expiryOf('2026-11-20', today, 5).state).toBe('valid');
    expect(expiryOf('2026-11-14', today, 5).state).toBe('expiring');
  });
});

import { todayIn } from './expiry';

describe('todayIn', () => {
  const at = new Date('2026-11-10T22:30:00Z');
  it('is the date in the zone, not in UTC', () => {
    expect(todayIn('UTC', at)).toBe('2026-11-10');
    expect(todayIn('Asia/Kolkata', at)).toBe('2026-11-11');
    expect(todayIn('Pacific/Pago_Pago', at)).toBe('2026-11-10');
    expect(todayIn('Pacific/Kiritimati', at)).toBe('2026-11-11');
  });
  it('uses UTC when the zone is missing or unknown', () => {
    expect(todayIn(undefined, at)).toBe('2026-11-10');
    expect(todayIn('Mars/Olympus', at)).toBe('2026-11-10');
  });
});
