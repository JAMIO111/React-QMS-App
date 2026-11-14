import { isIP } from 'node:net';

/**
 * The caller's address as the API sees it (docs/security-plan.md S2): Express's `req.ip`, which honours `trust proxy` (the number of proxy hops
 * set by TRUST_PROXY_HOPS), never a forwarding header read by us. IPv4-mapped IPv6 (`::ffff:203.0.113.10`) is the IPv4 address; a zone id is
 * dropped; anything that is not an IP address is null, which the network rule treats as a denial while it is enforced.
 */
export function clientAddress(ip: string | undefined | null): string | null {
  if (!ip) return null;
  let a = ip.trim().replace(/%.*$/, '');
  const mapped = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) a = mapped[1];
  return isIP(a) ? a.toLowerCase() : null;
}
