/**
 * The real Connector Agent (connector-agent/, .NET) against the real API (docs/connector-agent-plan.md AG1, AG2): a person makes a registration
 * token, the agent registers with it, runs, shows as online and answers a ping from the agent's page. Then a database connection: the password
 * is sealed as the browser seals it, the agent stores it, tests the connection against a real PostgreSQL, browses its schemas, tables and columns
 * and previews a table — and stops itself cleanly when revoked.
 * The database part needs the throwaway cluster on TCP (AGENT_TEST_PG_PORT, set by run-e2e.sh); without it only the AG1 part runs.
 *
 * Needs the built agent: `dotnet build connector-agent/src/Fortress.Agent.Host` and AGENT_BINARY=<path to FortressAgent.dll>
 * (or `bash connector-agent/run-e2e.sh`, which does both). Skipped without it, so the API suite runs where .NET is not installed.
 */
import { INestApplication } from '@nestjs/common';
import { ChildProcess, execFile, spawn } from 'node:child_process';
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import request from 'supertest';
import { giveControllerSeats, makeIds, requireDb, seed, startApp, token } from './helpers';

const binary = process.env.AGENT_BINARY;
const pgPort = process.env.AGENT_TEST_PG_PORT ? Number(process.env.AGENT_TEST_PG_PORT) : null;

/** Seal as the browser does (src/lib/sealCredential.js): ECDH P-256 → HKDF-SHA256 → AES-256-GCM, the connection id as associated data. */
function seal(sealingSpki: string, connectionId: string, plaintext: string) {
  const eph = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const secret = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey({ key: Buffer.from(sealingSpki, 'base64'), format: 'der', type: 'spki' }) });
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from('fortress-agent-credential-v1'), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(connectionId));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { epk: eph.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') };
}
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

  /** AG2 with the real agent and a real PostgreSQL: password, test, browse, preview. */
  async function databaseConnection(agentId: string) {
    await admin.query(`
      drop schema if exists bin_erp cascade;
      do $$ begin if exists (select 1 from pg_roles where rolname = 'bin_reader') then drop owned by bin_reader; drop role bin_reader; end if; end $$;
      create schema bin_erp;
      create table bin_erp."work orders" (id bigint primary key, "order no" text not null, qty numeric(12,3), due date);
      insert into bin_erp."work orders" select g, 'WO-' || g, g * 1.5, date '2026-01-01' + g from generate_series(1, 30) g;
      create table bin_erp.salaries (id int primary key);
      create role bin_reader login password 'bin-reader-pass';
      grant usage on schema bin_erp to bin_reader;
      grant select on bin_erp."work orders" to bin_reader;`);
    const job = async (path: string, body: object) => (await api().post(path).set(await as()).send(body).expect(201)).body as { id: string };
    const finished = (id: string, what: string) => until(what, async () => {
      const r = await api().get(`/api/v1/integrations/agent-jobs/${id}`).set(await as());
      return ['completed', 'failed'].includes(r.body.status) && r.body;
    }, 60_000);

    const created = await api().post('/api/v1/integrations/connections').set(await as()).send({
      providerKey: 'sql_agent', name: 'Factory database', externalSystem: 'factory-db', agentId,
      config: { engine: 'postgres', server: '127.0.0.1', port: pgPort, database: 'postgres', authType: 'password', encrypt: false },
    }).expect(201);
    const connectionId = created.body.id as string;
    const sealed = seal(created.body.agent.sealingKey, connectionId, JSON.stringify({ username: 'bin_reader', password: 'bin-reader-pass' }));
    const withPassword = await api().put(`/api/v1/integrations/connections/${connectionId}/agent-credential`).set(await as())
      .send({ keyId: created.body.agent.keyId, sealed }).expect(200);
    await finished(withPassword.body.agentJobs[0].id, 'the agent to store the password');
    const stored = await api().get(`/api/v1/integrations/connections/${connectionId}`).set(await as()).expect(200);
    expect(stored.body.agentCredential.status).toBe('stored');

    const tested = await api().post(`/api/v1/integrations/connections/${connectionId}/test`).set(await as()).expect(200);
    const test = await finished(tested.body.agentJobs[0].id, 'the connection test');
    expect(test.status).toBe('completed');
    expect(test.result.message).toMatch(/^Signed in to PostgreSQL \d+\.\d+ as bin_reader \(database postgres\)/);
    const afterTest = await api().get(`/api/v1/integrations/connections/${connectionId}`).set(await as()).expect(200);
    expect(afterTest.body.lastTest.ok).toBe(true);
    expect(afterTest.body.problems).toEqual([]);

    const path = `/api/v1/integrations/connections/${connectionId}/agent-jobs`;
    const schemas = await finished((await job(path, { kind: 'discover', request: { level: 'schemas' } })).id, 'the schemas');
    expect(schemas.result.schemas.map((x: { name: string }) => x.name)).toContain('bin_erp');
    const objects = await finished((await job(path, { kind: 'discover', request: { level: 'objects', schema: 'bin_erp' } })).id, 'the tables');
    expect(objects.result.objects.map((x: { name: string }) => x.name)).toEqual(['work orders']); // salaries cannot be read by this login
    const columns = await finished((await job(path, { kind: 'discover', request: { level: 'columns', schema: 'bin_erp', object: 'work orders' } })).id, 'the columns');
    expect(columns.result.columns[0]).toMatchObject({ name: 'id', primaryKey: true });
    const preview = await finished((await job(path, { kind: 'preview', request: { schema: 'bin_erp', object: 'work orders', limit: 3 } })).id, 'the preview');
    expect(preview.result.rows).toEqual([
      { id: 1, 'order no': 'WO-1', qty: '1.500', due: '2026-01-02' },
      { id: 2, 'order no': 'WO-2', qty: '3.000', due: '2026-01-03' },
      { id: 3, 'order no': 'WO-3', qty: '4.500', due: '2026-01-04' },
    ]);
    const refused = await finished((await job(path, { kind: 'preview', request: { schema: 'bin_erp', object: 'salaries' } })).id, 'the refused preview');
    expect(refused).toMatchObject({ status: 'failed', errorKind: 'not_found' });
    expect(output).not.toContain('bin-reader-pass');
  }

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
    expect(online.capabilities.jobs).toEqual(['discover', 'ping', 'preview', 'store_credential', 'test_connection']);
    expect(online.capabilities.adapters).toEqual(['postgres', 'sqlserver']);

    // Opening the agent's page wakes it to poll quickly, so the ping is answered within seconds.
    await api().post(`/api/v1/integrations/agents/${agentId}/wake`).set(await as()).expect(200);
    const ping = await api().post(`/api/v1/integrations/agents/${agentId}/ping`).set(await as()).send({}).expect(201);
    const done = await until('the ping to be answered', async () => {
      const r = await api().get(`/api/v1/integrations/agent-jobs/${ping.body.id}`).set(await as());
      return r.body.status === 'completed' && r.body;
    }, 60_000);
    expect(done.result).toMatchObject({ pong: true, version: online.version });
    expect(Math.abs(Date.parse(done.result.agentTime) - Date.now())).toBeLessThan(120_000);

    if (pgPort) await databaseConnection(agentId);

    await api().post(`/api/v1/integrations/agents/${agentId}/revoke`).set(await as()).send({ reason: 'End of test' }).expect(200);
    const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 90_000))]);
    expect({ code, output: code === 0 ? '' : output }).toEqual({ code: 0, output: '' });
    expect(output).toContain('revoked');

    // Nothing secret in what the agent printed or logged.
    expect(output).not.toContain(reg.body.token);
  }, 240_000);
});
