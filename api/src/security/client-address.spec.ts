import { clientAddress } from './client-address';

describe('clientAddress', () => {
  it('keeps IPv4 and IPv6, turns IPv4-mapped IPv6 into IPv4, drops a zone id', () => {
    expect(clientAddress('203.0.113.10')).toBe('203.0.113.10');
    expect(clientAddress('::ffff:203.0.113.10')).toBe('203.0.113.10');
    expect(clientAddress('2001:DB8::1')).toBe('2001:db8::1');
    expect(clientAddress('fe80::1%eth0')).toBe('fe80::1');
  });
  it('is null for nothing or anything that is not an address', () => {
    expect(clientAddress(undefined)).toBeNull();
    expect(clientAddress('')).toBeNull();
    expect(clientAddress('1.2.3.4, 5.6.7.8')).toBeNull();
    expect(clientAddress('unknown')).toBeNull();
  });
});
