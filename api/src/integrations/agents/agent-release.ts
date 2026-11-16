import { createHash, createPublicKey, verify } from 'node:crypto';

/**
 * Signed agent releases (docs/connector-agent-plan.md AG6b). A release manifest is a JSON text signed as it is: ECDSA P-256 / SHA-256 over its UTF-8
 * bytes, the signature as 64 bytes r‖s in base64 (the same form as the agent's request signatures). The private key stays offline with whoever
 * publishes releases; Fortress and the agent hold only public keys.
 *
 * Fortress checks a manifest against AGENT_RELEASE_KEYS before publishing it, so an operator cannot publish something the agents will refuse; the
 * agent checks it again against the keys built into it, and that check is the one that protects the customer.
 */
export const RELEASE_FORMAT = 'fortress-agent-release-v1';

/** The key id: the first 16 hex characters of the SHA-256 of the public key's SPKI bytes. */
export function releaseKeyId(spkiBase64: string): string {
  return createHash('sha256').update(Buffer.from(spkiBase64, 'base64')).digest('hex').slice(0, 16);
}

/** The public keys in AGENT_RELEASE_KEYS (comma or whitespace separated base64 SPKI); a key that is not a P-256 public key is left out. */
export function parseReleaseKeys(value: string | undefined): { keyId: string; spki: string }[] {
  if (!value) return [];
  const keys: { keyId: string; spki: string }[] = [];
  for (const spki of value.split(/[\s,]+/).filter(Boolean)) {
    try {
      const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') continue;
      keys.push({ keyId: releaseKeyId(spki), spki });
    } catch {
      // Not a public key: ignored.
    }
  }
  return keys;
}

/** The key that signed the manifest, or null when none of the keys did (or the signature is not 64 bytes). */
export function verifyRelease(manifest: string, signatureBase64: string, keys: { keyId: string; spki: string }[]): string | null {
  const signature = Buffer.from(signatureBase64, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== signatureBase64) return null;
  for (const k of keys) {
    const key = createPublicKey({ key: Buffer.from(k.spki, 'base64'), format: 'der', type: 'spki' });
    if (verify('sha256', Buffer.from(manifest, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, signature)) return k.keyId;
  }
  return null;
}

export type ReleaseManifest = {
  format: string;
  version: string;
  platform: 'win-x64' | 'linux-x64';
  url: string;
  sha256: string;
  size: number;
  notes?: string;
  createdAt?: string;
};

/** The problem with a manifest's contents in words, or null. The database checks the same again when it stores it. */
export function manifestProblem(manifest: string): string | null {
  let m: Partial<ReleaseManifest>;
  try {
    m = JSON.parse(manifest) as Partial<ReleaseManifest>;
  } catch {
    return 'The manifest is not JSON';
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'The manifest is not a JSON object';
  if (m.format !== RELEASE_FORMAT) return `The manifest is not a Fortress agent release (format ${RELEASE_FORMAT})`;
  if (typeof m.version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(m.version)) return 'The manifest\'s version must be three whole numbers, e.g. 0.7.0';
  if (m.platform !== 'win-x64' && m.platform !== 'linux-x64') return 'The manifest\'s platform must be win-x64 or linux-x64';
  if (typeof m.url !== 'string' || !/^https:\/\/[^\s/@]+(\/\S*)?$/.test(m.url)) return 'The manifest\'s address must be https';
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return 'The manifest needs the file\'s SHA-256 in lower-case hex';
  if (typeof m.size !== 'number' || !Number.isInteger(m.size) || m.size < 1 || m.size > 300 * 1024 * 1024) return 'The manifest needs the file\'s size in bytes (at most 300 MB)';
  return null;
}
