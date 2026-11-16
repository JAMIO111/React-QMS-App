#!/usr/bin/env node
// A tiny stand-in for Fortress's agent routes, for the Windows checks in CI (connector-agent/ci/windows-checks.ps1, AG6c). No dependencies.
// It accepts any signed request (signatures are checked by the real API's tests, not here), records what the agent says, hands out queued jobs
// and serves one release package. It also makes and keeps an in-memory release key for the update checks; the key is a throwaway, never a real one.
//
//   node fake-fortress.mjs <port> <state-file>
//
// Agent routes (under /api/v1/integrations/agent/): register, heartbeat, jobs/next, jobs/{id}/ack|progress|complete|fail, keys/rotate, deregister.
// Control routes for the checks script:
//   GET  /_state                 everything recorded so far (also written to <state-file> after every request)
//   GET  /_release-key           the throwaway release key's public half (base64 SPKI)
//   POST /_release {zip, version, platform?} sign a release of that zip (the file path on this machine) and queue an update_agent job for it
//   POST /_refuse {version}      answer heartbeats from that agent version with 503 (so an update never "checks in" and is rolled back)
//   GET  /package.zip            the package of the latest release (the agent is pointed here with FORTRESS_AGENT_TEST_DOWNLOAD)
import { createHash, generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, statSync, writeFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 8787);
const stateFile = process.argv[3] ?? 'fake-fortress-state.json';
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const releaseKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const state = { registered: [], heartbeats: [], reports: [], deregistered: 0, rotations: 0, refused: [], jobs: [] };
const queue = [];
let packagePath = null;

const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
const send = (res, status, body) => {
  res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(parts);
      try {
        resolve(raw.length ? JSON.parse(raw.toString('utf8')) : {});
      } catch {
        resolve({ binary: raw.length });
      }
    });
  });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;
  const body = req.method === 'POST' ? await readBody(req) : {};
  try {
    if (path === '/_state') return send(res, 200, state);
    if (path === '/_release-key') return send(res, 200, { publicKey: releaseKey });
    if (path === '/_refuse') {
      state.refused.push(body.version);
      return send(res, 200, { refused: state.refused });
    }
    if (path === '/_release') {
      const bytes = readFileSync(body.zip);
      packagePath = body.zip;
      const manifest = JSON.stringify({
        format: 'fortress-agent-release-v1',
        version: body.version,
        platform: body.platform ?? 'win-x64',
        url: 'https://downloads.example.invalid/fortress-agent.zip',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: statSync(body.zip).size,
        notes: 'CI check',
        createdAt: new Date().toISOString(),
      });
      const signature = sign('sha256', Buffer.from(manifest), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
      const updateId = randomUUID();
      queue.push({ id: randomUUID(), kind: 'update_agent', spec: { updateId, manifest, signature, version: body.version }, attempt: 1 });
      return send(res, 200, { updateId });
    }
    if (path === '/package.zip' && packagePath) {
      res.writeHead(200, { 'content-type': 'application/zip' });
      return res.end(readFileSync(packagePath));
    }

    const agent = path.match(/^\/api\/v1\/integrations\/agent\/(.+)$/)?.[1];
    if (!agent) return send(res, 404, { code: 'not_found', message: 'Not found' });
    if (agent === 'register') {
      state.registered.push({ version: body.version, machine: body.machine, platform: body.capabilities?.platform, at: new Date().toISOString() });
      return send(res, 201, {
        agentId: '00000000-0000-4000-8000-00000000a6c1',
        organisationId: '00000000-0000-4000-8000-0000000000c1',
        organisationName: 'CI organisation',
        name: 'CI agent',
        pollSeconds: 2,
        fingerprint: '',
      });
    }
    if (agent === 'heartbeat') {
      if (state.refused.includes(body.version)) return send(res, 503, { code: 'unavailable', message: 'Refused by the CI check' });
      state.heartbeats.push({ version: body.version, at: new Date().toISOString() });
      if (state.heartbeats.length > 200) state.heartbeats.shift();
      if (body.updateReport) state.reports.push({ ...body.updateReport, reportedBy: body.version });
      return send(res, 200, { revoked: false, jobsWaiting: queue.length > 0, pollSeconds: 2, serverTime: new Date().toISOString() });
    }
    if (agent === 'jobs/next') {
      const job = queue.shift();
      if (!job) return send(res, 204);
      state.jobs.push({ id: job.id, kind: job.kind, status: 'leased' });
      return send(res, 200, { ...job, leasedUntil: new Date(Date.now() + 300_000).toISOString() });
    }
    const report = agent.match(/^jobs\/([^/]+)\/(ack|progress|complete|fail)$/);
    if (report) {
      const job = state.jobs.find((j) => j.id === report[1]);
      if (job) {
        job.status = { ack: 'received', progress: 'running', complete: 'completed', fail: 'failed' }[report[2]];
        if (report[2] === 'complete') job.result = body.result ?? null;
        if (report[2] === 'fail') job.error = body.message ?? null;
      }
      return send(res, 200, { status: job?.status ?? 'unknown', cancelled: false });
    }
    if (agent === 'keys/rotate') {
      state.rotations += 1;
      return send(res, 200, {});
    }
    if (agent === 'deregister') {
      state.deregistered += 1;
      return send(res, 200, {});
    }
    return send(res, 404, { code: 'not_found', message: `No route ${agent}` });
  } finally {
    save();
  }
}).listen(port, '127.0.0.1', () => {
  save();
  console.log(`Fake Fortress on http://127.0.0.1:${port}/api/v1 (state in ${stateFile})`);
});
