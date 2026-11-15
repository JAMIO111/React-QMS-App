import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * How a Connector Agent proves who it is (docs/connector-agent-plan.md AG-D2, amended by AG0 §13): every request is signed with the agent's own
 * ECDSA P-256 key (SHA-256, IEEE P1363 r‖s, 64 bytes, base64). The signature covers a canonical string that binds the method, the path with its
 * query, a hash of the exact body bytes, the time, a one-off nonce and the agent id, so a request can be neither changed, replayed, moved to
 * another path nor passed off as another agent's. The private key never leaves the agent; the API keeps only the public key (SPKI, base64).
 */
export const AGENT_HEADERS = {
  id: 'x-agent-id',
  timestamp: 'x-agent-timestamp',
  nonce: 'x-agent-nonce',
  signature: 'x-agent-signature',
} as const;

/** Requests more than five minutes away from the server's clock are refused (and their nonces are kept ten). */
export const MAX_CLOCK_SKEW_SECONDS = 300;
/** The agent id stands in the canonical string; at registration (no id yet) it is this word. */
export const REGISTRATION_SUBJECT = 'register';

export interface SignedParts {
  method: string;
  /** The path as the agent requested it, with its query string. */
  path: string;
  body: Buffer | string | undefined | null;
  timestamp: string;
  nonce: string;
  agentId: string;
}

export const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export function canonicalString(p: SignedParts): string {
  const body = p.body ?? Buffer.alloc(0);
  return ['FORTRESS-AGENT-V1', p.method.toUpperCase(), p.path, sha256Hex(body), p.timestamp, p.nonce.toLowerCase(), p.agentId].join('\n');
}

/** The public key as Node's key object, or null unless it is a P-256 EC key in SPKI form. */
export function p256Key(spkiBase64: string | null | undefined): KeyObject | null {
  if (!spkiBase64 || !/^[A-Za-z0-9+/=]{40,400}$/.test(spkiBase64)) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null;
  } catch {
    return null;
  }
}

export function verifySignature(spkiBase64: string | null | undefined, parts: SignedParts, signatureBase64: string | undefined): boolean {
  const key = p256Key(spkiBase64);
  if (!key || !signatureBase64 || !/^[A-Za-z0-9+/=]{80,100}$/.test(signatureBase64)) return false;
  const signature = Buffer.from(signatureBase64, 'base64');
  if (signature.length !== 64) return false;
  try {
    return verify('sha256', Buffer.from(canonicalString(parts)), { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}

/** Unix seconds, within the allowed skew of now. */
export function freshTimestamp(timestamp: string | undefined, nowMs = Date.now(), skew = MAX_CLOCK_SKEW_SECONDS): boolean {
  if (!timestamp || !/^\d{9,11}$/.test(timestamp)) return false;
  return Math.abs(nowMs / 1000 - Number(timestamp)) <= skew;
}

export const validNonce = (nonce: string | undefined): nonce is string => !!nonce && /^[0-9a-fA-F]{32,64}$/.test(nonce);

/** A registration token as shown to the administrator: "FAGT-" + 43 characters of base64url (32 random bytes). */
export const TOKEN_PATTERN = /^FAGT-[A-Za-z0-9_-]{43}$/;
export const tokenHash = (token: string) => sha256Hex(token.trim());
