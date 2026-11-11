import { cellStatus, daysUntil, expiryState } from './competence-state';

describe('competence state', () => {
  const today = '2026-11-11';
  it('counts days across month ends', () => {
    expect(daysUntil('2026-12-11', today)).toBe(30);
    expect(daysUntil('2026-11-10', today)).toBe(-1);
  });
  it('works out expiry, valid through the expiry date itself', () => {
    expect(expiryState(null, today)).toBe('none');
    expect(expiryState('2026-11-11', today)).toBe('expiring');
    expect(expiryState('2026-11-10', today)).toBe('expired');
    expect(expiryState('2027-01-10', today)).toBe('expiring'); // 60 days
    expect(expiryState('2027-01-11', today)).toBe('valid'); // 61 days
  });
  it('flags a gap before anything else', () => {
    expect(cellStatus({ level: 1, required: 3, expiresOn: '2026-11-01' }, today)).toEqual({ status: 'gap', gap: 2, expiry: 'expired' });
  });
  it('treats a skill never assessed but required as a full gap', () => {
    expect(cellStatus({ level: null, required: 2, expiresOn: null }, today)).toEqual({ status: 'not_assessed', gap: 2, expiry: 'none' });
  });
  it('does not lower the level for expiry, only flags it', () => {
    expect(cellStatus({ level: 3, required: 3, expiresOn: '2026-10-01' }, today)).toEqual({ status: 'expired', gap: 0, expiry: 'expired' });
    expect(cellStatus({ level: 4, required: 3, expiresOn: '2026-12-01' }, today).status).toBe('expiring');
    expect(cellStatus({ level: 3, required: 3, expiresOn: null }, today).status).toBe('ok');
  });
  it('is never a problem when nothing requires the skill', () => {
    expect(cellStatus({ level: 2, required: null, expiresOn: '2026-01-01' }, today).status).toBe('extra');
    expect(cellStatus({ level: null, required: null, expiresOn: null }, today).status).toBe('not_assessed');
  });
});
