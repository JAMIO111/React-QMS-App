import { createHash, randomBytes } from 'node:crypto';

/** What every reporting key starts with, so the API can tell one from a person's token without asking the database. */
export const REPORT_KEY_PREFIX = 'fqr_';

export interface MadeReportKey {
  /** The key itself, shown to the person once and never stored. */
  secret: string;
  /** SHA-256 of the key, hex: the only thing the database keeps. */
  hash: string;
  /** Eight characters after the prefix, so a person can tell their keys apart in a list. */
  prefix: string;
}

export const hashReportKey = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('hex');

/** A new key: `fqr_` + 32 random bytes in base64url (43 characters). */
export function makeReportKey(): MadeReportKey {
  const secret = REPORT_KEY_PREFIX + randomBytes(32).toString('base64url');
  return { secret, hash: hashReportKey(secret), prefix: secret.slice(REPORT_KEY_PREFIX.length, REPORT_KEY_PREFIX.length + 8) };
}

const KEY_SHAPE = /^fqr_[A-Za-z0-9_-]{43}$/;

/**
 * The reporting key in an Authorization header, or null when the header carries something else (a person's token goes the normal way).
 * Two forms: `Bearer <key>`, and `Basic base64(<any user name>:<key>)`, which is how Power BI's Basic credential sends its password, so the key never
 * has to be written into a report file. A header that starts like a key but is malformed is returned as-is so it is refused, not read as a token.
 */
export function reportKeyFrom(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const bearer = authorization.match(/^Bearer\s+(\S+)$/i);
  if (bearer) return bearer[1].startsWith(REPORT_KEY_PREFIX) ? bearer[1] : null;
  const basic = authorization.match(/^Basic\s+(\S+)$/i);
  if (basic) {
    let decoded = '';
    try {
      decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    } catch {
      return null;
    }
    const password = decoded.slice(decoded.indexOf(':') + 1);
    return decoded.includes(':') && password.startsWith(REPORT_KEY_PREFIX) ? password : null;
  }
  return null;
}

export const looksLikeReportKey = (secret: string): boolean => KEY_SHAPE.test(secret);
