// AG0 spike, Node side (what the API and the browser will do). Run with the folder the C# spike writes to:
//   node verify.mjs seal <dir>     seal a database password to the agent's sealing key with WebCrypto, exactly as the browser will
//   node verify.mjs check <dir>    verify the agent's signature, refuse tampered / stale requests, check the sealed password came back, gunzip the batch
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, createPublicKey, verify, webcrypto } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const [mode, dir = '.'] = process.argv.slice(2);
const pub = JSON.parse(readFileSync(join(dir, 'agent-public.json'), 'utf8'));
const b64 = (u8) => Buffer.from(u8).toString('base64');
const PASSWORD = 'S3cr3t!-reader-only';
const CONNECTION = '0f4b8c2a-1111-4c6e-9e2b-7a1d2c3b4e5f';

if (mode === 'seal') {
  const { subtle } = webcrypto;
  const agentKey = await subtle.importKey('spki', Buffer.from(pub.sealingKey, 'base64'), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: agentKey }, eph.privateKey, 256);
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('fortress-agent-credential-v1') },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(CONNECTION) }, key, new TextEncoder().encode(PASSWORD));
  const epk = await subtle.exportKey('spki', eph.publicKey);
  writeFileSync(join(dir, 'sealed.json'), JSON.stringify({ connectionId: CONNECTION, epk: b64(epk), iv: b64(iv), ct: b64(ct) }));
  console.log('sealed', { bytes: ct.byteLength, ed25519InBcl: pub.ed25519InBcl, runtime: pub.runtime });
  process.exit(0);
}

const out = JSON.parse(readFileSync(join(dir, 'agent-out.json'), 'utf8'));
const key = createPublicKey({ key: Buffer.from(pub.signingKey, 'base64'), format: 'der', type: 'spki' });
const canonicalFor = (o) => ['FORTRESS-AGENT-V1', 'POST', '/api/v1/integrations/agent/heartbeat',
  createHash('sha256').update(o.body).digest('hex'), o.timestamp, o.nonce, o.agentId].join('\n');
const ok = (o) => verify('sha256', Buffer.from(canonicalFor(o)), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(out.signature, 'base64'));
const fresh = (o) => Math.abs(Date.now() / 1000 - Number(o.timestamp)) <= 300;

const results = {
  signatureValid: ok(out) && fresh(out),
  canonicalMatches: canonicalFor(out) === out.canonical,
  tamperedBodyRefused: !ok({ ...out, body: out.body.replace('0.1.0', '9.9.9') }),
  otherAgentRefused: !ok({ ...out, agentId: '00000000-0000-0000-0000-000000000000' }),
  otherNonceRefused: !ok({ ...out, nonce: 'f'.repeat(32) }),
  staleRefused: !fresh({ ...out, timestamp: String(Number(out.timestamp) - 301) }),
  credentialOpenedByAgent: out.opened === PASSWORD,
};
const gz = readFileSync(join(dir, 'batch-1.json.gz'));
const checksumOk = createHash('sha256').update(gz).digest('hex') === out.batch.sha256;
const batch = JSON.parse(gunzipSync(gz, { maxOutputLength: 8 * 1024 * 1024 }).toString('utf8'));
let bombRefused = false;
try { gunzipSync(gz, { maxOutputLength: 1024 }); } catch { bombRefused = true; }
Object.assign(results, {
  batchChecksumOk: checksumOk,
  batchRows: batch.rows.length,
  batchTypesKept: typeof batch.rows[0].LINE === 'number' && typeof batch.rows[0].ON_HOLD === 'boolean' && batch.rows.some((r) => r.NOTES === null),
  batchRawKb: Math.round(out.batch.rawBytes / 1024),
  batchGzipKb: Math.round(out.batch.gzipBytes / 1024),
  inflateCapRefusesOversize: bombRefused,
  drivers: out.drivers,
});
console.log(JSON.stringify(results, null, 2));
const must = ['signatureValid', 'canonicalMatches', 'tamperedBodyRefused', 'otherAgentRefused', 'otherNonceRefused', 'staleRefused', 'credentialOpenedByAgent', 'batchChecksumOk', 'batchTypesKept', 'inflateCapRefusesOversize'];
const failed = must.filter((k) => !results[k]);
if (failed.length || results.batchRows !== 1000) { console.error('FAILED:', failed); process.exit(1); }
console.log('AG0 spike: all checks pass');
