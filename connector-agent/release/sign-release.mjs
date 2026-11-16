#!/usr/bin/env node
// Sign a Fortress Connector Agent release (docs/connector-agent-plan.md AG6b).
//
//   node sign-release.mjs --key <private-key.pem> --zip <package.zip> --version 0.7.0 --platform win-x64 --url https://…/agent-0.7.0.zip [--notes "…"]
//
// Prints the manifest (the exact text that is signed) and its signature. Upload the zip to the https address first, then paste both into the
// operator panel (/platform → Agent releases → Publish). Fortress checks the signature against AGENT_RELEASE_KEYS and each agent checks it again
// against the keys built into it, then checks the download's size and SHA-256 against the manifest.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  if (!k?.startsWith('--') || process.argv[i + 1] === undefined) {
    console.error(`Unexpected argument ${k}`);
    process.exit(2);
  }
  args[k.slice(2)] = process.argv[i + 1];
}
const problems = [];
if (!args.key) problems.push('--key is required');
if (!args.zip) problems.push('--zip is required');
if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(args.version ?? '')) problems.push('--version must be three whole numbers, e.g. 0.7.0');
if (!['win-x64', 'linux-x64'].includes(args.platform ?? '')) problems.push('--platform must be win-x64 or linux-x64');
try {
  if (new URL(args.url ?? '').protocol !== 'https:') problems.push('--url must be https');
} catch {
  problems.push('--url must be an https address');
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(2);
}

const bytes = readFileSync(args.zip);
const manifest = JSON.stringify({
  format: 'fortress-agent-release-v1',
  version: args.version,
  platform: args.platform,
  url: args.url,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  size: statSync(args.zip).size,
  notes: args.notes ?? '',
  createdAt: new Date().toISOString(),
});
const key = createPrivateKey(readFileSync(args.key));
const signature = sign('sha256', Buffer.from(manifest), { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
console.log('Manifest:');
console.log(manifest);
console.log('\nSignature:');
console.log(signature);
console.log(`\nSigned with key id ${createHash('sha256').update(spki).digest('hex').slice(0, 16)}`);
