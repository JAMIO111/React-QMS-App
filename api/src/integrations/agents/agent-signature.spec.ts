import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalString, freshTimestamp, p256Key, sha256Hex, SignedParts, TOKEN_PATTERN, tokenHash, validNonce, verifySignature } from './agent-signature';
import { AGENT_MESSAGES } from './agents.controller';
import { keyFingerprint } from './agents.service';

const keys = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey };
};
const signParts = (privateKey: ReturnType<typeof keys>['privateKey'], parts: SignedParts) =>
  sign('sha256', Buffer.from(canonicalString(parts)), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');

const base: SignedParts = {
  method: 'POST',
  path: '/api/v1/integrations/agent/heartbeat',
  body: Buffer.from('{"version":"0.1.0"}'),
  timestamp: String(Math.floor(Date.now() / 1000)),
  nonce: 'a'.repeat(32),
  agentId: '7b0c5a3e-9d4f-4f1e-9a63-2a5e5a1d1c01',
};

describe('agent request signatures', () => {
  it('accepts a request signed with the agent\'s key', () => {
    const k = keys();
    expect(verifySignature(k.spki, base, signParts(k.privateKey, base))).toBe(true);
  });

  it('refuses anything changed after signing', () => {
    const k = keys();
    const sig = signParts(k.privateKey, base);
    expect(verifySignature(k.spki, { ...base, body: Buffer.from('{"version":"9.9.9"}') }, sig)).toBe(false);
    expect(verifySignature(k.spki, { ...base, path: '/api/v1/integrations/agent/deregister' }, sig)).toBe(false);
    expect(verifySignature(k.spki, { ...base, method: 'GET' }, sig)).toBe(false);
    expect(verifySignature(k.spki, { ...base, nonce: 'b'.repeat(32) }, sig)).toBe(false);
    expect(verifySignature(k.spki, { ...base, timestamp: String(Number(base.timestamp) + 1) }, sig)).toBe(false);
    expect(verifySignature(k.spki, { ...base, agentId: '00000000-0000-0000-0000-000000000000' }, sig)).toBe(false);
  });

  it('refuses another agent\'s key and malformed signatures', () => {
    const k = keys();
    const other = keys();
    const sig = signParts(k.privateKey, base);
    expect(verifySignature(other.spki, base, sig)).toBe(false);
    expect(verifySignature(k.spki, base, undefined)).toBe(false);
    expect(verifySignature(k.spki, base, 'not base64 !')).toBe(false);
    expect(verifySignature(k.spki, base, Buffer.alloc(64).toString('base64'))).toBe(false);
    expect(verifySignature(null, base, sig)).toBe(false);
  });

  it('an empty body hashes the same as no body', () => {
    const k = keys();
    const sig = signParts(k.privateKey, { ...base, body: Buffer.alloc(0) });
    expect(verifySignature(k.spki, { ...base, body: undefined }, sig)).toBe(true);
  });

  it('accepts only P-256 public keys', () => {
    expect(p256Key(keys().spki)).not.toBeNull();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(p256Key(rsa)).toBeNull();
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(p256Key(p384)).toBeNull();
    expect(p256Key('A'.repeat(88))).toBeNull();
  });

  it('timestamps within five minutes, nonces of hex, tokens of the agreed shape', () => {
    const now = Date.now();
    expect(freshTimestamp(String(Math.floor(now / 1000) - 299), now)).toBe(true);
    expect(freshTimestamp(String(Math.floor(now / 1000) - 301), now)).toBe(false);
    expect(freshTimestamp(String(Math.floor(now / 1000) + 301), now)).toBe(false);
    expect(freshTimestamp('soon', now)).toBe(false);
    expect(validNonce('a'.repeat(32))).toBe(true);
    expect(validNonce('xyz')).toBe(false);
    expect(TOKEN_PATTERN.test(`FAGT-${Buffer.alloc(32, 7).toString('base64url')}`)).toBe(true);
    expect(TOKEN_PATTERN.test('FAGT-short')).toBe(false);
    expect(tokenHash(' FAGT-x ')).toBe(tokenHash('FAGT-x'));
  });
});

describe('the contract with the agent (connector-agent/contract)', () => {
  const contract = (name: string) =>
    JSON.parse(readFileSync(join(__dirname, '../../../../connector-agent/contract', name), 'utf8'));

  it('builds the same canonical string and accepts the vector signature', () => {
    const v = contract('signature-vector.json');
    const parts = { method: v.method, path: v.path, body: Buffer.from(v.body), timestamp: v.timestamp, nonce: v.nonce, agentId: v.agentId };
    expect(sha256Hex(v.body)).toBe(v.bodySha256);
    expect(canonicalString(parts)).toBe(v.canonical);
    expect(verifySignature(v.publicKey, parts, v.signature)).toBe(true);
    expect(verifySignature(v.publicKey, { ...parts, body: Buffer.from(`${v.body} `) }, v.signature)).toBe(false);
    expect(keyFingerprint(v.publicKey)).toBe(v.fingerprint);
  });

  it.each(Object.keys(AGENT_MESSAGES))('accepts the agent\'s %s message', (name) => {
    const schema = AGENT_MESSAGES[name as keyof typeof AGENT_MESSAGES];
    const parsed = schema.safeParse(contract(`messages/${name}.json`));
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it('the keys in the messages are real P-256 keys', () => {
    for (const name of ['register', 'rotate']) {
      const m = contract(`messages/${name}.json`) as { signingKey: string; sealingKey: string };
      expect(p256Key(m.signingKey)).not.toBeNull();
      expect(p256Key(m.sealingKey)).not.toBeNull();
    }
  });
});
