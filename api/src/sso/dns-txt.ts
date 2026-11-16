import { Resolver } from 'node:dns/promises';

/**
 * Looking up a domain's TXT records, for proving that an organisation owns the email domain it wants to use for single sign-on
 * (docs/sso-plan.md SS3). Abstract so tests can answer without the network; production uses the system resolver with a time limit.
 */
export abstract class DnsTxtResolver {
  /** Every TXT record at the name, each one's pieces joined. Throws a node DNS error (`code` ENOTFOUND, ENODATA, ETIMEOUT …) when the lookup fails. */
  abstract txt(name: string): Promise<string[]>;
}

export class SystemDnsTxtResolver extends DnsTxtResolver {
  async txt(name: string): Promise<string[]> {
    const resolver = new Resolver({ timeout: 4_000, tries: 2 });
    const records = await resolver.resolveTxt(name);
    return records.map((pieces) => pieces.join(''));
  }
}

/** The record a domain must carry: `fortress-verification=<token>`. */
export const verificationValue = (token: string) => `fortress-verification=${token}`;

/** Codes meaning "the name answers, but has no such record" or "no such name": the record is simply not there (yet). */
const ABSENT = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN', 'ENONAME']);

/**
 * Whether the domain carries the verification record. Never throws: a lookup that fails is `found: false` with an error in words, so the caller can
 * record it. Matching ignores case and spaces around the value (DNS consoles differ), but the token itself must match exactly.
 */
export async function checkVerificationRecord(
  resolver: DnsTxtResolver,
  domain: string,
  token: string,
): Promise<{ found: boolean; error: string | null }> {
  const wanted = verificationValue(token).toLowerCase();
  try {
    const records = await resolver.txt(domain);
    if (records.some((r) => r.trim().toLowerCase() === wanted)) return { found: true, error: null };
    const ours = records.filter((r) => r.trim().toLowerCase().startsWith('fortress-verification='));
    return {
      found: false,
      error: ours.length
        ? `${domain} has a Fortress verification record, but not this one. Check the value was copied in full.`
        : `No Fortress verification record was found at ${domain} yet. DNS changes can take up to an hour to appear.`,
    };
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (ABSENT.has(code)) {
      return { found: false, error: `No Fortress verification record was found at ${domain} yet. DNS changes can take up to an hour to appear.` };
    }
    return { found: false, error: `The DNS lookup for ${domain} did not answer (${code || 'error'}). Try again in a few minutes.` };
  }
}
