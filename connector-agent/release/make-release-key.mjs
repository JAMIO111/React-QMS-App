#!/usr/bin/env node
// Make a release signing key for the Fortress Connector Agent (docs/connector-agent-plan.md AG6b).
//
//   node make-release-key.mjs <private-key-file>
//
// Writes the private key (PKCS#8 PEM, readable only by you) to the file given — keep it OFF this repository, ideally on an offline machine or in a
// secret store — and prints the public key (base64 SPKI) and its key id. Put the public key in two places:
//   1. connector-agent/src/Fortress.Agent.Core/Updates.cs → ReleaseKeys.Built (so agents trust it), then build and ship that agent by hand once;
//   2. the API's AGENT_RELEASE_KEYS environment variable (comma-separated), so Fortress accepts releases signed with it.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) {
  console.error('Usage: node make-release-key.mjs <private-key-file>');
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`${out} already exists; refusing to overwrite a key.`);
  process.exit(2);
}
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
const spki = publicKey.export({ type: 'spki', format: 'der' });
console.log(`Private key written to ${out} (keep it secret and out of git).`);
console.log(`Public key (base64 SPKI): ${spki.toString('base64')}`);
console.log(`Key id: ${createHash('sha256').update(spki).digest('hex').slice(0, 16)}`);
