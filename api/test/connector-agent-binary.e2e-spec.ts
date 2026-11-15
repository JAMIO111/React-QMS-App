/**
 * The real Connector Agent (connector-agent/, .NET) against the real API (docs/connector-agent-plan.md AG1): a person makes a registration
 * token, the agent registers with it, runs, shows as online, answers a ping from the agent's page, and stops itself cleanly when revoked.
 *
 * Needs the built agent: `dotnet build connector-agent/src/Fortress.Agent.Host` and AGENT_BINARY=<path to FortressAgent.dll>
 * (or `bash connector-agent/run-e2e.sh`, which does both). Skipped without it, so the API suite runs where .NET is not installed.
 */
import { INestApplication } from '@nestjs/common';
import { ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import request from 'supertest';
import { giveControllerSeats, makeIds, requireDb, seed, startApp, token } from './helpers';

const binary = process.env.AGENT_BINARY;
const run = promisify(execFile);
const maybe = binary ? describe : describe.skip;

maybe('the real connector agent', () => {
  const ids = makeIds('a92');
  let app: INestApplication;
  let admin: Pool;
  let base: string;
  let dataDir: string;
  let agentProcess: ChildProcess | undefined;
  let output = '';
  const as = async () => ({ Authorization: `Bearer ${await token(ids.ownerA)}`, 'X-Organisation-Id': ids.orgA });
  const api = () => request(app.getHttpServer());
  const agent = (...args: string[]) => run('dotnet', [binary!, ...args, '--data-dir', dataDir], { timeout: 60_000 });
  const until = async <T>(what: string, check: () => Promise<T | undefined | false>, ms = 45_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await check();
      if (v) return v;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Agent output:\n${output}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: requireDb().adminUrl });
    await seed(admin, ids, '-ag1bin');
    await giveControllerSeats(admin, ids.orgA, [ids.ownerA]);
    app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`;
    dataDir = mkdtempSync(join(tmpdir(), 'fortress-agent-e2e-'));
  }, 60_000);
  afterAll(async () => {
    agentProcess?.kill();
    await app?.close();
    await admin?.end();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('registers, comes online, answers a ping and stops when revoked', async () => {
    const reg = await api().post('/api/v1/integrations/agent-registrations').set(await as()).send({ name: 'Real agent', location: 'Test bench' }).expect(201);

    // A wrong address or token never gets as far as Fortress.
    await expect(agent('register', '--api', 'http://fortress.example.com/api/v1', '--token', reg.body.token)).rejects.toMatchObject({ code: 2 });

    const registered = await agent('register', '--api', base, '--token', reg.body.token);
    expect(registered.stdout).toContain('Registered as "Real agent"');
    const agentId = /Agent id: ([0-9a-f-]{36})/.exec(registered.stdout)![1];
    const fingerprint = /Key fingerprint: ([0-9a-f ]{19})/.exec(registered.stdout)![1];

    // The token works once.
    await expect(agent('register', '--api', base, '--token', reg.body.token, '--replace')).rejects.toMatchObject({ code: 1 });
    expect((await agent('status')).stdout).toContain(agentId);

    const page = await api().get(`/api/v1/integrations/agents/${agentId}`).set(await as()).expect(200);
    expect(page.body.keys[0].fingerprint).toBe(fingerprint);

    agentProcess = spawn('dotnet', [binary!, 'run', '--data-dir', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    agentProcess.stdout!.on('data', (d) => (output += d));
    agentProcess.stderr!.on('data', (d) => (output += d));
    const exited = new Promise<number | null>((resolve) => agentProcess!.on('exit', (code) => resolve(code)));

    const online = await until('the agent to come online', async () => {
      const r = await api().get(`/api/v1/integrations/agents/${agentId}`).set(await as());
      return r.body.online && r.body;
    });
    expect(online.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(online.capabilities.jobs).toEqual(['ping']);

    // Opening the agent's page wakes it to poll quickly, so the ping is answered within seconds.
    await api().post(`/api/v1/integrations/agents/${agentId}/wake`).set(await as()).expect(200);
    const ping = await api().post(`/api/v1/integrations/agents/${agentId}/ping`).set(await as()).send({}).expect(201);
    const done = await until('the ping to be answered', async () => {
      const r = await api().get(`/api/v1/integrations/agent-jobs/${ping.body.id}`).set(await as());
      return r.body.status === 'completed' && r.body;
    }, 60_000);
    expect(done.result).toMatchObject({ pong: true, version: online.version });
    expect(Math.abs(Date.parse(done.result.agentTime) - Date.now())).toBeLessThan(120_000);

    await api().post(`/api/v1/integrations/agents/${agentId}/revoke`).set(await as()).send({ reason: 'End of test' }).expect(200);
    const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 90_000))]);
    expect({ code, output: code === 0 ? '' : output }).toEqual({ code: 0, output: '' });
    expect(output).toContain('revoked');

    // Nothing secret in what the agent printed or logged.
    expect(output).not.toContain(reg.body.token);
  }, 240_000);
});
