import { FailureLimiter } from './agent.guard';

describe('failed agent sign-ins per address (AG6d)', () => {
  it('blocks an address after the limit within the window and lets it in again after', () => {
    let now = 1_000_000;
    const f = new FailureLimiter(3, 60_000, () => now);
    for (let i = 0; i < 3; i++) {
      expect(f.blocked('203.0.113.9')).toBe(false);
      f.record('203.0.113.9');
    }
    expect(f.blocked('203.0.113.9')).toBe(true);
    expect(f.blocked('198.51.100.1')).toBe(false); // another address is not affected
    now += 60_001;
    expect(f.blocked('203.0.113.9')).toBe(false);
  });
});
