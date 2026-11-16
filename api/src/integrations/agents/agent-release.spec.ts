import { generateKeyPairSync, sign } from 'node:crypto';
import { manifestProblem, parseReleaseKeys, releaseKeyId, verifyRelease } from './agent-release';

const pair = () => {
  const p = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey: p.privateKey, spki: p.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
};
const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ format: 'fortress-agent-release-v1', version: '0.7.0', platform: 'win-x64', url: 'https://releases.example.com/a.zip', sha256: 'a'.repeat(64), size: 1024, ...over });

describe('agent release signatures', () => {
  const a = pair();
  const b = pair();
  const keys = parseReleaseKeys(`${a.spki}, ${b.spki}`);
  const signWith = (k: ReturnType<typeof pair>, text: string) => sign('sha256', Buffer.from(text), { key: k.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');

  it('says which key signed a manifest', () => {
    const m = manifest();
    expect(verifyRelease(m, signWith(b, m), keys)).toBe(releaseKeyId(b.spki));
    expect(releaseKeyId(a.spki)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses a changed manifest, another key, or a malformed signature', () => {
    const m = manifest();
    const sig = signWith(a, m);
    expect(verifyRelease(m.replace('a.zip', 'b.zip'), sig, keys)).toBeNull();
    expect(verifyRelease(m, signWith(pair(), m), keys)).toBeNull();
    expect(verifyRelease(m, sig.slice(0, -4) + 'AAA=', keys)).toBeNull();
    expect(verifyRelease(m, 'not base64!', keys)).toBeNull();
    expect(verifyRelease(m, sig, [])).toBeNull();
  });

  it('keeps only P-256 public keys from the setting', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(parseReleaseKeys(`${a.spki}\n${rsa} junk`).map((k) => k.spki)).toEqual([a.spki]);
    expect(parseReleaseKeys(undefined)).toEqual([]);
  });

  it('checks what a manifest says', () => {
    expect(manifestProblem(manifest())).toBeNull();
    expect(manifestProblem('nope')).toMatch(/not JSON/);
    expect(manifestProblem(manifest({ format: 'other' }))).toMatch(/format/);
    expect(manifestProblem(manifest({ version: '1.0' }))).toMatch(/three whole numbers/);
    expect(manifestProblem(manifest({ platform: 'mac' }))).toMatch(/platform/);
    expect(manifestProblem(manifest({ url: 'http://x.example.com/a.zip' }))).toMatch(/https/);
    expect(manifestProblem(manifest({ url: 'https://user@x.example.com/a.zip' }))).toMatch(/https/);
    expect(manifestProblem(manifest({ sha256: 'ABC' }))).toMatch(/SHA-256/);
    expect(manifestProblem(manifest({ size: 1.5 }))).toMatch(/size/);
  });
});
