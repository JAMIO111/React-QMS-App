/**
 * The real Connector Agent (connector-agent/, .NET) against the real API (docs/connector-agent-plan.md AG1, AG2): a person makes a registration
 * token, the agent registers with it, runs, shows as online and answers a ping from the agent's page. Then a database connection: the password
 * is sealed as the browser seals it, the agent stores it, tests the connection against a real PostgreSQL, browses its schemas, tables and columns
 * previews a table and imports one (AG3) — and stops itself cleanly when revoked.
 * The database part needs the throwaway cluster on TCP (AGENT_TEST_PG_PORT, set by run-e2e.sh); without it only the AG1 part runs.
 *
 * Needs the built agent: `dotnet build connector-agent/src/Fortress.Agent.Host` and AGENT_BINARY=<path to FortressAgent.dll>
 * (or `bash connector-agent/run-e2e.sh`, which does both). Skipped without it, so the API suite runs where .NET is not installed.
 */
import { INestApplication } from '@nestjs/common';
import { ChildProcess, execFile, spawn } from 'node:child_process';
import { createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo, createServer as createTcpServer, Server as TcpServer, Socket, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { zipSync } from 'fflate';
import { Pool } from 'pg';
import request from 'supertest';
import { giveControllerSeats, makeIds, requireDb, seed, startApp, token } from './helpers';

const binary = process.env.AGENT_BINARY;
const pgPort = process.env.AGENT_TEST_PG_PORT ? Number(process.env.AGENT_TEST_PG_PORT) : null;
const myPort = process.env.AGENT_TEST_MYSQL_PORT ? Number(process.env.AGENT_TEST_MYSQL_PORT) : null;
/** AG6a load test (AG-D4), opt-in: AGENT_LOAD_ROWS=1000000 imports that many rows of a 20-column table twice; AGENT_LOAD_REPORT=<file> keeps the figures. */
const loadRows = process.env.AGENT_LOAD_ROWS ? Number(process.env.AGENT_LOAD_ROWS) : 0;

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
  let exited: Promise<number | null> = Promise.resolve(null);
  let output = '';
  // The agent reaches the API through this proxy, so a test can make the API unreachable for a while (AG6a recovery).
  let proxy: TcpServer;
  let proxyBase: string;
  let apiDown = false;
  let refusedWhileDown = 0;
  const proxied = new Set<Socket>();
  const setApiDown = (down: boolean) => {
    apiDown = down;
    refusedWhileDown = 0;
    if (down) for (const s of proxied) s.destroy();
  };
  // AG6b: a release key of the test's own, trusted by the API and (through the test-hooks build) by the agent, and a local server for the package.
  const releaseKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const releaseSpki = releaseKey.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  let releaseServer: Server;
  let releaseBytes = Buffer.alloc(0);
  let releaseUrl = '';
  const startAgent = () => {
    agentProcess = spawn('dotnet', [binary!, 'run', '--data-dir', dataDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORTRESS_AGENT_TEST_RELEASE_KEY: releaseSpki, FORTRESS_AGENT_TEST_DOWNLOAD: releaseUrl },
    });
    agentProcess.stdout!.on('data', (d) => (output += d));
    agentProcess.stderr!.on('data', (d) => (output += d));
    const p = agentProcess;
    exited = new Promise<number | null>((resolve) => p.on('exit', (code) => resolve(code)));
  };
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
    await admin.query(`insert into public.platform_admins (user_id, note) values ($1, 'e2e operator') on conflict do nothing`, [ids.outsider]);
    app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000', AGENT_RELEASE_KEYS: releaseSpki });
    await app.listen(0, '127.0.0.1');
    releaseServer = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'application/zip' }).end(releaseBytes));
    await new Promise<void>((r) => releaseServer.listen(0, '127.0.0.1', () => r()));
    releaseUrl = `http://127.0.0.1:${(releaseServer.address() as AddressInfo).port}/agent.zip`;
    const apiPort = (app.getHttpServer().address() as AddressInfo).port;
    base = `http://127.0.0.1:${apiPort}/api/v1`;
    proxy = createTcpServer((client) => {
      if (apiDown) {
        refusedWhileDown++;
        return void client.destroy();
      }
      const upstream = connect(apiPort, '127.0.0.1');
      proxied.add(client);
      proxied.add(upstream);
      const end = () => {
        client.destroy();
        upstream.destroy();
        proxied.delete(client);
        proxied.delete(upstream);
      };
      client.on('error', end).on('close', end);
      upstream.on('error', end).on('close', end);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    proxyBase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/api/v1`;
    dataDir = mkdtempSync(join(tmpdir(), 'fortress-agent-e2e-'));
  }, 60_000);
  afterAll(async () => {
    agentProcess?.kill();
    for (const sock of proxied) sock.destroy();
    proxy?.close();
    releaseServer?.close();
    await app?.close();
    await admin?.end();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * AG6b with the real agent: an operator publishes a release signed with the test's key; the owner approves it; the agent checks the signature with
   * its own trusted keys, downloads the package and refuses it when the bytes are not the signed ones, then stages a good one (pending.json and the
   * unpacked files in its data folder) and Fortress shows it staged. On Linux the agent does not swap itself (that is the Windows updater's job).
   */
  async function updates(agentId: string, current: string) {
    const operator = { Authorization: `Bearer ${await token(ids.outsider, { aal: 'aal2' })}` };
    const [maj, min, build] = current.split('.').map(Number);
    const pkg = Buffer.from(zipSync({ 'FortressAgent.dll': new TextEncoder().encode('the next agent'), 'lib/helper.dll': new TextEncoder().encode('helper') }));
    const publish = async (version: string) => {
      const manifest = JSON.stringify({
        format: 'fortress-agent-release-v1', version, platform: 'linux-x64', url: 'https://releases.example.com/agent.zip',
        sha256: createHash('sha256').update(pkg).digest('hex'), size: pkg.length, notes: `Version ${version}`, createdAt: new Date().toISOString(),
      });
      const signature = sign('sha256', Buffer.from(manifest), { key: releaseKey.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
      return (await api().post('/api/v1/platform/agent-releases').set(operator).send({ manifest, signature }).expect(201)).body.id as string;
    };
    const approve = async (releaseId: string) =>
      (await api().post(`/api/v1/integrations/agents/${agentId}/updates`).set(await as()).send({ releaseId }).expect(201)).body as { id: string };
    const settled = (updateId: string, want: string[]) =>
      until(`the update to be ${want.join(' or ')}`, async () => {
        const r = await api().get(`/api/v1/integrations/agents/${agentId}`).set(await as());
        const u = r.body.updates.find((x: { id: string }) => x.id === updateId);
        return u && want.includes(u.status) && u;
      }, 60_000);

    // Served bytes that are not the signed ones: the agent refuses them and Fortress records the update as failed.
    releaseBytes = Buffer.from(pkg);
    releaseBytes[Math.floor(releaseBytes.length / 2)] ^= 0xff;
    const bad = await approve(await publish(`${maj}.${min}.${build + 1}`));
    const failed = await settled(bad.id, ['failed', 'staged']);
    expect(failed).toMatchObject({ status: 'failed', message: expect.stringContaining('SHA-256') });
    expect(existsSync(join(dataDir, 'updates', 'pending.json'))).toBe(false);

    // The signed bytes: staged.
    releaseBytes = pkg;
    const good = await approve(await publish(`${maj}.${min}.${build + 2}`));
    const staged = await settled(good.id, ['staged', 'failed']);
    expect(staged).toMatchObject({ status: 'staged', toVersion: `${maj}.${min}.${build + 2}` });
    const pending = JSON.parse(readFileSync(join(dataDir, 'updates', 'pending.json'), 'utf8'));
    expect(pending).toMatchObject({ updateId: good.id, version: `${maj}.${min}.${build + 2}`, sha256: createHash('sha256').update(pkg).digest('hex') });
    expect(readFileSync(join(pending.staged, 'FortressAgent.dll'), 'utf8')).toBe('the next agent');
    expect(readFileSync(join(pending.staged, 'lib', 'helper.dll'), 'utf8')).toBe('helper');
    expect(output).toContain('does not swap it in by itself');
    // The staged update is the one open update; a second approval waits until it is settled.
    const again = await publish(`${maj}.${min}.${build + 3}`);
    await api().post(`/api/v1/integrations/agents/${agentId}/updates`).set(await as()).send({ releaseId: again }).expect(409);
  }

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
    await extraction(connectionId, finished);
    await folderConnection(agentId, finished);
    await restConnection(agentId, finished);
    if (myPort) await mysqlConnection(agentId, finished, connectionId);
    await recovery(connectionId);
    if (loadRows) await load(connectionId);
  }

  /** AG3 with the real agent and a real PostgreSQL: a table chosen for machines, a sample, a template, then an import of 1,100 rows in two batches. */
  async function extraction(connectionId: string, finished: (id: string, what: string) => Promise<any>) {
    await admin.query(`
      create table bin_erp.machines (id int primary key, code text not null, name text not null, plant text not null, active boolean not null);
      insert into bin_erp.machines select g, 'BIN-M' || lpad(g::text, 4, '0'), 'Machine ' || g, 'MAIN', g % 12 <> 0 from generate_series(1, 1200) g;
      grant select on bin_erp.machines to bin_reader;`);
    const conn = `/api/v1/integrations/connections/${connectionId}`;
    await api().post(`${conn}/ready`).set(await as()).send({}).expect(200);
    expect((await api().post(`${conn}/activate`).set(await as()).send({}).expect(200)).body.status).toBe('active');
    const source = { schema: 'bin_erp', object: 'machines', keyColumn: 'id', columns: ['id', 'code', 'name', 'plant'], filters: [{ column: 'active', op: 'eq', value: true }] };
    await api().put(`${conn}/record-source`).set(await as()).send({ entityType: 'machine', source }).expect(200);
    const sampleJob = await api().post(`${conn}/agent-jobs`).set(await as()).send({ kind: 'preview', request: { schema: 'bin_erp', object: 'machines', limit: 20 } }).expect(201);
    await finished(sampleJob.body.id, 'the sample');
    const sample = (await api().post(`${conn}/sample`).set(await as()).send({ entityType: 'machine' }).expect(200)).body;
    expect(sample.columns).toEqual(['id', 'code', 'name', 'plant']);
    const fields = [{ target: 'code', source: 'code' }, { target: 'name', source: 'name' }, { target: 'site', source: 'plant' }];
    const templateId = (await api().post('/api/v1/integrations/templates').set(await as()).send({
      entityType: 'machine', name: 'Factory machines', keyField: 'id', fields, expectedColumns: sample.columns, settings: { writeMode: 'add_update', matchExisting: false },
    }).expect(201)).body.id;

    const importOnce = async () => {
      const started = (await api().post(`${conn}/runs`).set(await as()).send({ entityType: 'machine', kind: 'full', templateId }).expect(201)).body;
      return until('the import to finish', async () => {
        const r = (await api().post(`/api/v1/integrations/runs/${started.id}/continue`).set(await as()).send({})).body;
        return ['succeeded', 'partial', 'failed'].includes(r.status) && r;
      }, 120_000);
    };
    const first = await importOnce();
    expect(first).toMatchObject({ status: 'succeeded', counts: { total: 1100, created: 1100 } });
    const job = (await admin.query(`select progress, result from public.integration_agent_jobs where run_id = $1`, [first.id])).rows[0];
    expect(job.result).toMatchObject({ batches: 2, rows: 1100 });
    expect((await admin.query(`select count(*)::int as n from public.machines where organisation_id = $1 and code like 'BIN-M%'`, [ids.orgA])).rows[0].n).toBe(1100);
    const again = await importOnce();
    expect(again).toMatchObject({ status: 'succeeded', counts: { total: 1100, created: 0, updated: 0, unchanged: 1100 } });

    // AG4: with a column that shows when a row changed, a full read sets the mark and an incremental read brings only the rows changed since.
    await admin.query(`
      alter table bin_erp.machines add column changed timestamptz not null default timestamptz '2026-11-01 08:00+00';
      update bin_erp.machines set changed = timestamptz '2026-11-01 08:00+00' + make_interval(secs => id);`);
    await api().put(`${conn}/record-source`).set(await as()).send({ entityType: 'machine', source: { ...source, columns: [...source.columns, 'changed'], changedColumn: 'changed' } }).expect(200);
    const marked = await importOnce();
    expect(marked).toMatchObject({ status: 'succeeded', counts: { total: 1100, created: 0 } });
    const cursorOf = async () => JSON.parse((await admin.query(`select cursor from public.integration_sync_cursors where connection_id = $1 and entity_type = 'machine'`, [connectionId])).rows[0].cursor);
    expect(new Date((await cursorOf()).w).toISOString()).toBe('2026-11-01T08:19:59.000Z'); // row 1199, the highest active row (1200 is inactive)
    await admin.query(`update bin_erp.machines set name = name || ' (rebuilt)', changed = timestamptz '2026-11-10 09:00+00' where id in (5, 6, 7)`);
    const started = (await api().post(`${conn}/runs`).set(await as()).send({ entityType: 'machine', kind: 'incremental', templateId }).expect(201)).body;
    const inc = await until('the incremental import to finish', async () => {
      const r = (await api().post(`/api/v1/integrations/runs/${started.id}/continue`).set(await as()).send({})).body;
      return ['succeeded', 'partial', 'failed'].includes(r.status) && r;
    }, 120_000);
    // The row at the old mark is read again (changed >= mark), and is unchanged; the three rebuilt ones are updated.
    expect(inc).toMatchObject({ kind: 'incremental', status: 'succeeded', counts: { updated: 3 } });
    expect(inc.counts.total).toBeLessThanOrEqual(4);
    expect((await admin.query(`select name from public.machines where organisation_id = $1 and code = 'BIN-M0006'`, [ids.orgA])).rows[0].name).toBe('Machine 6 (rebuilt)');
    expect(new Date((await cursorOf()).w).toISOString()).toBe('2026-11-10T09:00:00.000Z');
  }

  /**
   * AG5a: the same agent also reads a real MySQL / MariaDB (AGENT_TEST_MYSQL_PORT, set by mysql-check.sh) while its PostgreSQL connection stays
   * in use — one agent, two kinds of database. Password sealed for the agent, test, a table chosen, a sample, a template, an import; then the
   * PostgreSQL connection imports again unchanged.
   */
  /**
   * AG5b: the same agent reads a real folder. Only once the folder is on its allow-list; a preview of the newest matching file becomes the sample;
   * an import reads 600 rows; an incremental read of the same file sends nothing; a changed file updates only what changed.
   */
  async function folderConnection(agentId: string, finished: (id: string, what: string) => Promise<any>) {
    const folder = join(dataDir, 'exports');
    mkdirSync(folder, { recursive: true });
    const write = (name: string, rows: string[], modified: Date) => {
      writeFileSync(join(folder, name), ['Code,Name,Plant', ...rows].join('\r\n') + '\r\n');
      utimesSync(join(folder, name), modified, modified);
    };
    const machines = (n: number, renamed?: number) => Array.from({ length: n }, (_, i) => `FLD-${i + 1},${i + 1 === renamed ? 'Renamed' : 'Folder machine'} ${i + 1},MAIN`);
    write('machines-2026-11-14.csv', machines(3), new Date('2026-11-14T06:00:00Z'));
    write('machines-2026-11-15.csv', machines(600), new Date('2026-11-15T06:00:00Z'));
    writeFileSync(join(folder, 'notes.txt.bak'), 'not a table');
    const created = await api().post('/api/v1/integrations/connections').set(await as()).send({
      providerKey: 'sql_agent', name: 'Exports folder', externalSystem: 'exports-folder', agentId, config: { engine: 'folder', folder, authType: 'none' },
    }).expect(201);
    const conn = `/api/v1/integrations/connections/${created.body.id}`;
    // Not on the agent's allow-list yet: refused on the agent's machine.
    const refused = await finished((await api().post(`${conn}/test`).set(await as()).expect(200)).body.agentJobs[0].id, 'the refused folder test');
    expect(refused).toMatchObject({ status: 'failed', errorKind: 'refused' });
    writeFileSync(join(dataDir, 'allowlist.json'), JSON.stringify({ folders: [folder] }));
    const tested = await finished((await api().post(`${conn}/test`).set(await as()).expect(200)).body.agentJobs[0].id, 'the folder test');
    expect(tested.status).toBe('completed');
    expect(tested.result.message).toMatch(/can be read: 3 files, 2 of them CSV or Excel/);
    const files = await finished((await api().post(`${conn}/agent-jobs`).set(await as()).send({ kind: 'discover', request: { level: 'files' } }).expect(201)).body.id, 'the file list');
    expect(files.result.files.map((f: { name: string }) => f.name)).toEqual(['machines-2026-11-14.csv', 'machines-2026-11-15.csv', 'notes.txt.bak']);
    await api().post(`${conn}/ready`).set(await as()).send({}).expect(200);
    expect((await api().post(`${conn}/activate`).set(await as()).send({}).expect(200)).body.status).toBe('active');
    await api().put(`${conn}/record-source`).set(await as()).send({ entityType: 'machine', source: { file: 'machines-*.csv' } }).expect(200);
    const preview = await finished((await api().post(`${conn}/agent-jobs`).set(await as()).send({ kind: 'preview', request: { file: 'machines-*.csv', limit: 5 } }).expect(201)).body.id, 'the file preview');
    expect(preview.status).toBe('completed');
    expect(preview.result.file.name).toBe('machines-2026-11-15.csv');
    expect(preview.result.rows[0]).toEqual({ Code: 'FLD-1', Name: 'Folder machine 1', Plant: 'MAIN' });
    const sample = (await api().post(`${conn}/sample`).set(await as()).send({ entityType: 'machine' }).expect(200)).body;
    const templateId = (await api().post('/api/v1/integrations/templates').set(await as()).send({
      entityType: 'machine', name: 'Folder machines', keyField: 'Code',
      fields: [{ target: 'code', source: 'Code' }, { target: 'name', source: 'Name' }, { target: 'site', source: 'Plant' }],
      expectedColumns: sample.columns, settings: { writeMode: 'add_update', matchExisting: false },
    }).expect(201)).body.id;
    const importAs = async (kind: 'full' | 'incremental') => {
      const started = (await api().post(`${conn}/runs`).set(await as()).send({ entityType: 'machine', kind, templateId }).expect(201)).body;
      return until(`the ${kind} folder import`, async () => {
        const r = (await api().post(`/api/v1/integrations/runs/${started.id}/continue`).set(await as()).send({})).body;
        return ['succeeded', 'partial', 'failed'].includes(r.status) && r;
      }, 120_000);
    };
    expect(await importAs('full')).toMatchObject({ status: 'succeeded', counts: { total: 600, created: 600 } });
    expect((await admin.query(`select count(*)::int as n from public.machines where organisation_id = $1 and code like 'FLD-%'`, [ids.orgA])).rows[0].n).toBe(600);
    expect(await importAs('incremental')).toMatchObject({ kind: 'incremental', status: 'succeeded', counts: { total: 0 } });
    write('machines-2026-11-16.csv', machines(600, 7), new Date('2026-11-16T06:00:00Z'));
    expect(await importAs('incremental')).toMatchObject({ status: 'succeeded', counts: { total: 600, updated: 1, unchanged: 599 } });
    expect((await admin.query(`select name from public.machines where organisation_id = $1 and code = 'FLD-7'`, [ids.orgA])).rows[0].name).toBe('Renamed 7');
  }

  /**
   * AG5c: the same agent reads an internal REST API (a small one on 127.0.0.1 that needs a bearer token). Refused until its host is on the agent's
   * allow-list; then tested, an address tried (records flattened as the cloud connector does), 250 records imported in pages, and an incremental
   * read that asks the API only for what changed since the mark.
   */
  async function restConnection(agentId: string, finished: (id: string, what: string) => Promise<any>) {
    const records = Array.from({ length: 250 }, (_, i) => ({ code: `API-${i + 1}`, name: `API machine ${i + 1}`, site: { code: 'MAIN' }, updatedAt: '2026-11-16T00:00:00Z' }));
    const asked: string[] = [];
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://127.0.0.1');
      asked.push(url.pathname + url.search);
      if (req.headers.authorization !== 'Bearer rest-erp-token') return void res.writeHead(401).end('{}');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/erp/health') return void res.end('{"ok":true}');
      if (url.pathname !== '/erp/v1/machines') return void res.writeHead(404).end('{}');
      const page = Number(url.searchParams.get('page') ?? 1);
      const size = Number(url.searchParams.get('per_page') ?? 100);
      const since = url.searchParams.get('since');
      const all = records.filter((r) => !since || r.updatedAt >= since);
      res.end(JSON.stringify({ data: all.slice((page - 1) * size, page * size), total: all.length }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const created = await api().post('/api/v1/integrations/connections').set(await as()).send({
        providerKey: 'sql_agent', name: 'ERP API', externalSystem: 'erp-api', agentId,
        config: { engine: 'rest', baseUrl: `http://127.0.0.1:${port}/erp`, authType: 'bearer', testPath: '/health' },
      }).expect(201);
      const id = created.body.id as string;
      const conn = `/api/v1/integrations/connections/${id}`;
      const sealed = seal(created.body.agent.sealingKey, id, JSON.stringify({ username: '', password: 'rest-erp-token' }));
      const withToken = await api().put(`${conn}/agent-credential`).set(await as()).send({ keyId: created.body.agent.keyId, sealed }).expect(200);
      await finished(withToken.body.agentJobs[0].id, 'the agent to store the token');
      // Not on the agent's allow-list yet: refused on the agent's machine, and the API is never called.
      const refused = await finished((await api().post(`${conn}/test`).set(await as()).expect(200)).body.agentJobs[0].id, 'the refused API test');
      expect(refused).toMatchObject({ status: 'failed', errorKind: 'refused' });
      expect(refused.errorMessage).toMatch(/is not on this agent's allow-list/);
      expect(asked).toEqual([]);
      writeFileSync(join(dataDir, 'allowlist.json'), JSON.stringify({ folders: [join(dataDir, 'exports')], hosts: [`127.0.0.1:${port}`] }));
      // Listed, but plain http: the token would cross the network readable, so the agent will not send it unless the allow-list says so (AG6d).
      const plain = await finished((await api().post(`${conn}/test`).set(await as()).expect(200)).body.agentJobs[0].id, 'the plain-http API test');
      expect(plain).toMatchObject({ status: 'failed', errorKind: 'refused' });
      expect(plain.errorMessage).toMatch(/plainHttpSignIn/);
      expect(asked).toEqual([]);
      writeFileSync(join(dataDir, 'allowlist.json'), JSON.stringify({ folders: [join(dataDir, 'exports')], hosts: [`127.0.0.1:${port}`], plainHttpSignIn: true }));
      const tested = await finished((await api().post(`${conn}/test`).set(await as()).expect(200)).body.agentJobs[0].id, 'the API test');
      expect(tested).toMatchObject({ status: 'completed', result: { message: 'The API answered 200 at /erp/health' } });
      await api().post(`${conn}/ready`).set(await as()).send({}).expect(200);
      expect((await api().post(`${conn}/activate`).set(await as()).send({}).expect(200)).body.status).toBe('active');
      const source = { path: '/v1/machines', recordsPath: 'data', paging: { style: 'page', pageSize: 100 }, keyColumn: 'code', changedColumn: 'updatedAt', changedParam: 'since' };
      await api().put(`${conn}/record-source`).set(await as()).send({ entityType: 'machine', source }).expect(200);
      const preview = await finished((await api().post(`${conn}/agent-jobs`).set(await as())
        .send({ kind: 'preview', request: { path: source.path, recordsPath: 'data', paging: source.paging, limit: 5 } }).expect(201)).body.id, 'the API preview');
      expect(preview.status).toBe('completed');
      expect(preview.result.rows[0]).toEqual({ code: 'API-1', name: 'API machine 1', 'site.code': 'MAIN', updatedAt: '2026-11-16T00:00:00Z' });
      const sample = (await api().post(`${conn}/sample`).set(await as()).send({ entityType: 'machine' }).expect(200)).body;
      expect(sample.columns).toEqual(['code', 'name', 'site.code', 'updatedAt']);
      const templateId = (await api().post('/api/v1/integrations/templates').set(await as()).send({
        entityType: 'machine', name: 'ERP API machines', keyField: 'code',
        fields: [{ target: 'code', source: 'code' }, { target: 'name', source: 'name' }, { target: 'site', source: 'site.code' }],
        expectedColumns: sample.columns, settings: { writeMode: 'add_update', matchExisting: false },
      }).expect(201)).body.id;
      const importAs = async (kind: 'full' | 'incremental') => {
        const started = (await api().post(`${conn}/runs`).set(await as()).send({ entityType: 'machine', kind, templateId }).expect(201)).body;
        return until(`the ${kind} API import`, async () => {
          const r = (await api().post(`/api/v1/integrations/runs/${started.id}/continue`).set(await as()).send({})).body;
          return ['succeeded', 'partial', 'failed'].includes(r.status) && r;
        }, 120_000);
      };
      asked.length = 0;
      expect(await importAs('full')).toMatchObject({ status: 'succeeded', counts: { total: 250, created: 250 } });
      expect(asked.filter((a) => a.startsWith('/erp/v1/machines'))).toHaveLength(3);
      expect((await admin.query(`select count(*)::int as n from public.machines where organisation_id = $1 and code like 'API-%'`, [ids.orgA])).rows[0].n).toBe(250);
      records[6] = { ...records[6], name: 'Renamed API machine', updatedAt: '2026-11-16T09:00:00Z' };
      asked.length = 0;
      expect(await importAs('incremental')).toMatchObject({ kind: 'incremental', status: 'succeeded', counts: { total: 250, updated: 1 } });
      expect(asked[0]).toContain('since=2026-11-16T00%3A00%3A00Z');
      expect((await admin.query(`select name from public.machines where organisation_id = $1 and code = 'API-7'`, [ids.orgA])).rows[0].name).toBe('Renamed API machine');
      asked.length = 0;
      expect(await importAs('incremental')).toMatchObject({ status: 'succeeded', counts: { total: 1, unchanged: 1 } });
      expect(asked[0]).toContain('since=2026-11-16T09%3A00%3A00Z');
      expect(output).not.toContain('rest-erp-token');
    } finally {
      server.close();
    }
  }

  async function mysqlConnection(agentId: string, finished: (id: string, what: string) => Promise<any>, pgConnectionId: string) {
    const mysql = (sql: string) => run('mariadb', ['--no-defaults', '-h127.0.0.1', `-P${myPort}`, '-uroot', '-pcheck-root', '-e', sql]);
    await mysql(`
      drop database if exists bin_my; drop user if exists 'bin_my_reader'@'%';
      create database bin_my;
      create table bin_my.machines (id int primary key, code varchar(20) not null, name varchar(60) not null, plant varchar(10) not null);
      insert into bin_my.machines with recursive g (n) as (select 1 union all select n + 1 from g where n < 40)
        select n, concat('MY-M', lpad(n, 3, '0')), concat('MySQL machine ', n), 'MAIN' from g;
      create user 'bin_my_reader'@'%' identified by 'bin-my-pass';
      grant select on bin_my.machines to 'bin_my_reader'@'%';`);
    const created = await api().post('/api/v1/integrations/connections').set(await as()).send({
      providerKey: 'sql_agent', name: 'Plant MySQL', externalSystem: 'plant-mysql', agentId,
      config: { engine: 'mysql', server: '127.0.0.1', port: myPort, database: 'bin_my', authType: 'password', encrypt: false },
    }).expect(201);
    const id = created.body.id as string;
    const conn = `/api/v1/integrations/connections/${id}`;
    const sealed = seal(created.body.agent.sealingKey, id, JSON.stringify({ username: 'bin_my_reader', password: 'bin-my-pass' }));
    const withPassword = await api().put(`${conn}/agent-credential`).set(await as()).send({ keyId: created.body.agent.keyId, sealed }).expect(200);
    await finished(withPassword.body.agentJobs[0].id, 'the agent to store the MySQL password');
    const tested = await api().post(`${conn}/test`).set(await as()).expect(200);
    const test = await finished(tested.body.agentJobs[0].id, 'the MySQL connection test');
    expect(test.status).toBe('completed');
    expect(test.result.message).toMatch(/^Signed in to (MySQL|MariaDB) \d+\.\d+(\.\d+)? as bin_my_reader@%? ?\(database bin_my\)/);
    await api().post(`${conn}/ready`).set(await as()).send({}).expect(200);
    expect((await api().post(`${conn}/activate`).set(await as()).send({}).expect(200)).body.status).toBe('active');
    const schemas = await finished((await api().post(`${conn}/agent-jobs`).set(await as()).send({ kind: 'discover', request: { level: 'schemas' } }).expect(201)).body.id, 'the MySQL schemas');
    expect(schemas.result.schemas.map((x: { name: string }) => x.name)).toEqual(['bin_my']);
    const source = { schema: 'bin_my', object: 'machines', keyColumn: 'id', columns: ['id', 'code', 'name', 'plant'] };
    await api().put(`${conn}/record-source`).set(await as()).send({ entityType: 'machine', source }).expect(200);
    const sampleJob = await api().post(`${conn}/agent-jobs`).set(await as()).send({ kind: 'preview', request: { schema: 'bin_my', object: 'machines', limit: 20 } }).expect(201);
    await finished(sampleJob.body.id, 'the MySQL sample');
    const sample = (await api().post(`${conn}/sample`).set(await as()).send({ entityType: 'machine' }).expect(200)).body;
    expect(sample.rows[0].v).toEqual({ id: '1', code: 'MY-M001', name: 'MySQL machine 1', plant: 'MAIN' });
    const fields = [{ target: 'code', source: 'code' }, { target: 'name', source: 'name' }, { target: 'site', source: 'plant' }];
    const templateId = (await api().post('/api/v1/integrations/templates').set(await as()).send({
      entityType: 'machine', name: 'Plant MySQL machines', keyField: 'id', fields, expectedColumns: sample.columns, settings: { writeMode: 'add_update', matchExisting: false },
    }).expect(201)).body.id;
    const importFrom = async (connectionId: string, template: string) => {
      const started = (await api().post(`/api/v1/integrations/connections/${connectionId}/runs`).set(await as()).send({ entityType: 'machine', kind: 'full', templateId: template }).expect(201)).body;
      return until('the import to finish', async () => {
        const r = (await api().post(`/api/v1/integrations/runs/${started.id}/continue`).set(await as()).send({})).body;
        return ['succeeded', 'partial', 'failed'].includes(r.status) && r;
      }, 120_000);
    };
    expect(await importFrom(id, templateId)).toMatchObject({ status: 'succeeded', counts: { total: 40, created: 40 } });
    expect((await admin.query(`select count(*)::int as n from public.machines where organisation_id = $1 and code like 'MY-M%'`, [ids.orgA])).rows[0].n).toBe(40);
    expect(output).not.toContain('bin-my-pass');
    // The PostgreSQL connection on the same agent still reads, and writes nothing new.
    const pgTemplate = (await admin.query(`select id from public.integration_templates where organisation_id = $1 and name = 'Factory machines'`, [ids.orgA])).rows[0].id;
    expect(await importFrom(pgConnectionId, pgTemplate)).toMatchObject({ status: 'succeeded', counts: { created: 0 } });
  }

  /**
   * AG6a recovery (AG6-D5), with the real agent and a real PostgreSQL. Each case reads 6,000 rows through a view that sleeps 2 ms a row, so a read
   * takes about 12 seconds and something can go wrong part-way: the agent killed and started again, the API unreachable for a while, the database
   * dropping the agent's connection. In every case the import ends with each row exactly once.
   */
  async function recovery(connectionId: string) {
    const conn = `/api/v1/integrations/connections/${connectionId}`;
    const templateId = (await admin.query(`select id from public.integration_templates where organisation_id = $1 and name = 'Factory machines'`, [ids.orgA])).rows[0].id;
    await admin.query(`
      create or replace function bin_erp.slowly(integer) returns boolean language sql as 'select pg_sleep(0.002) is not null';
      grant execute on function bin_erp.slowly(integer) to bin_reader;`);
    const ROWS = 6000;
    const prepare = async (name: string, from: number) => {
      await admin.query(`
        create table bin_erp.${name}_t (id int primary key, code text not null, name text not null, plant text not null);
        insert into bin_erp.${name}_t select g, 'REC-${name.toUpperCase()}-' || g, 'Recovery ' || g, 'MAIN' from generate_series(${from + 1}, ${from + ROWS}) g;
        create view bin_erp.${name} as select id, code, name, plant from bin_erp.${name}_t where bin_erp.slowly(id);
        grant select on bin_erp.${name} to bin_reader;`);
      await api().put(`${conn}/record-source`).set(await as()).send({ entityType: 'machine', source: { schema: 'bin_erp', object: name, keyColumn: 'id', columns: ['id', 'code', 'name', 'plant'] } }).expect(200);
    };
    const start = async () => (await api().post(`${conn}/runs`).set(await as()).send({ entityType: 'machine', kind: 'full', templateId }).expect(201)).body.id as string;
    const jobOf = async (runId: string) => (await admin.query(`select id, status, attempts from public.integration_agent_jobs where run_id = $1`, [runId])).rows[0];
    const batchesOf = async (jobId: string) => (await admin.query(`select count(*)::int as n from public.integration_agent_batches where job_id = $1`, [jobId])).rows[0].n as number;
    /** Wait until the agent has sent at least two batches and is still reading: the moment to break something. */
    const partWay = async (runId: string) => {
      const job = await until('the agent to be part-way through', async () => {
        const j = await jobOf(runId);
        return j && (await batchesOf(j.id)) >= 2 && j;
      }, 60_000);
      expect({ status: job.status, batches: await batchesOf(job.id) }).toMatchObject({ status: 'running' });
      expect(await batchesOf(job.id)).toBeLessThan(ROWS / 1000);
      return job;
    };
    const finish = (runId: string) => until('the import to finish', async () => {
      const r = (await api().post(`/api/v1/integrations/runs/${runId}/continue`).set(await as()).send({})).body;
      return ['succeeded', 'partial', 'failed'].includes(r.status) && r;
    }, 300_000);
    const imported = async (name: string) =>
      (await admin.query(`select count(*)::int as n, count(distinct code)::int as d from public.machines where organisation_id = $1 and code like $2`, [ids.orgA, `REC-${name.toUpperCase()}-%`])).rows[0];

    // 1. The agent is killed part-way and started again: it resumes from the first batch Fortress does not have (the lease is ended by hand to save five minutes).
    await prepare('rec_kill', 100000);
    const killRun = await start();
    const killJob = await partWay(killRun);
    agentProcess!.kill('SIGKILL');
    await exited;
    await admin.query(`update public.integration_agent_jobs set leased_until = now() - interval '1 second' where id = $1`, [killJob.id]);
    startAgent();
    const afterKill = await finish(killRun);
    expect(afterKill).toMatchObject({ status: 'succeeded', counts: { total: ROWS, created: ROWS } });
    expect(await jobOf(killRun)).toMatchObject({ status: 'completed', attempts: 2 });
    expect(await batchesOf(killJob.id)).toBe(ROWS / 1000);
    expect(await imported('rec_kill')).toEqual({ n: ROWS, d: ROWS });

    // 2. The API cannot be reached part-way (until the agent has been turned away at least twice, then three seconds more): the agent waits and
    //    sends the batch again inside the same attempt.
    await prepare('rec_net', 200000);
    const netRun = await start();
    await partWay(netRun);
    setApiDown(true);
    await until('the agent to be turned away twice', async () => refusedWhileDown >= 2, 60_000);
    await new Promise((r) => setTimeout(r, 3000));
    setApiDown(false);
    const afterNet = await finish(netRun);
    expect(afterNet).toMatchObject({ status: 'succeeded', counts: { total: ROWS, created: ROWS } });
    expect(await jobOf(netRun)).toMatchObject({ status: 'completed', attempts: 1 });
    expect(output).toMatch(/Could not send (batch \d+|progress|the result) to Fortress/);
    expect(await imported('rec_net')).toEqual({ n: ROWS, d: ROWS });

    // 3. The database drops the agent's connection part-way (as a restart would): the attempt fails as a passing problem and the next one resumes.
    await prepare('rec_db', 300000);
    const dbRun = await start();
    await partWay(dbRun);
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where usename = 'bin_reader'`);
    const afterDb = await finish(dbRun);
    expect(afterDb).toMatchObject({ status: 'succeeded', counts: { total: ROWS, created: ROWS } });
    expect((await jobOf(dbRun)).attempts).toBeGreaterThanOrEqual(2);
    expect(await imported('rec_db')).toEqual({ n: ROWS, d: ROWS });
    expect(output).not.toContain('bin-reader-pass');
  }

  /** The agent's peak resident memory so far, in MB (Linux: VmHWM of the agent process). */
  const peakMemoryMb = () => {
    try {
      const status = readFileSync(`/proc/${agentProcess!.pid}/status`, 'utf8');
      return Math.round(Number(/VmHWM:\s+(\d+) kB/.exec(status)![1]) / 1024);
    } catch {
      return null;
    }
  };

  /**
   * AG6a load test (AG-D4): a 20-column table of AGENT_LOAD_ROWS rows imported from PostgreSQL through the real agent, then again with nothing
   * written. Passes when every row arrives exactly once both times; time, batches and the agent's peak memory are printed and kept in AGENT_LOAD_REPORT.
   */
  async function load(connectionId: string) {
    const conn = `/api/v1/integrations/connections/${connectionId}`;
    const templateId = (await admin.query(`select id from public.integration_templates where organisation_id = $1 and name = 'Factory machines'`, [ids.orgA])).rows[0].id;
    const extra = Array.from({ length: 16 }, (_, i) => `c${i + 1}`);
    await admin.query(`
      create table bin_erp.load_t (id int primary key, code text not null, name text not null, plant text not null, ${extra.map((c, i) => `${c} ${i % 4 === 0 ? 'numeric(12,3)' : i % 4 === 1 ? 'date' : i % 4 === 2 ? 'boolean' : 'text'}`).join(', ')});
      insert into bin_erp.load_t select g, 'LOAD-' || g, 'Load machine ' || g, 'MAIN', ${extra.map((_, i) => (i % 4 === 0 ? 'g * 1.25' : i % 4 === 1 ? "date '2026-01-01' + (g % 365)" : i % 4 === 2 ? 'g % 2 = 0' : "md5(g::text)")).join(', ')}
        from generate_series(1000001, ${1000000 + loadRows}) g;
      grant select on bin_erp.load_t to bin_reader;`);
    await api().put(`${conn}/record-source`).set(await as()).send({ entityType: 'machine', source: { schema: 'bin_erp', object: 'load_t', keyColumn: 'id', columns: ['id', 'code', 'name', 'plant', ...extra] } }).expect(200);
    const once = async () => {
      const t0 = Date.now();
      const runId = (await api().post(`${conn}/runs`).set(await as()).send({ entityType: 'machine', kind: 'full', templateId }).expect(201)).body.id;
      let extracted: number | null = null;
      const run = await until('the load import', async () => {
        const r = (await api().post(`/api/v1/integrations/runs/${runId}/continue`).set(await as()).send({})).body;
        if (extracted === null && r.agent?.status === 'completed') extracted = Date.now() - t0;
        return ['succeeded', 'partial', 'failed'].includes(r.status) && r;
      }, 6 * 3600_000);
      const job = (await admin.query(`select result from public.integration_agent_jobs where run_id = $1`, [runId])).rows[0];
      return { run, seconds: Math.round((Date.now() - t0) / 1000), extractSeconds: extracted === null ? null : Math.round(extracted / 1000), batches: job.result.batches, rows: job.result.rows };
    };
    const first = await once();
    expect(first.run).toMatchObject({ status: 'succeeded', counts: { total: loadRows, created: loadRows } });
    expect((await admin.query(`select count(*)::int as n, count(distinct code)::int as d from public.machines where organisation_id = $1 and code like 'LOAD-%'`, [ids.orgA])).rows[0]).toEqual({ n: loadRows, d: loadRows });
    const second = await once();
    expect(second.run).toMatchObject({ status: 'succeeded', counts: { total: loadRows, created: 0, updated: 0, unchanged: loadRows } });
    const report = {
      rows: loadRows, columns: 20,
      first: { seconds: first.seconds, extractSeconds: first.extractSeconds, batches: first.batches, rows: first.rows },
      second: { seconds: second.seconds, extractSeconds: second.extractSeconds, batches: second.batches, rows: second.rows },
      agentPeakMemoryMb: peakMemoryMb(),
    };
    // eslint-disable-next-line no-console
    console.log(`AG6a load test: ${JSON.stringify(report)}`);
    if (process.env.AGENT_LOAD_REPORT) writeFileSync(process.env.AGENT_LOAD_REPORT, JSON.stringify(report, null, 2));
    expect(first.rows).toBe(loadRows);
    expect(first.batches).toBe(Math.ceil(loadRows / 1000));
  }

  it('registers, comes online, answers a ping and stops when revoked', async () => {
    const reg = await api().post('/api/v1/integrations/agent-registrations').set(await as()).send({ name: 'Real agent', location: 'Test bench' }).expect(201);

    // A wrong address or token never gets as far as Fortress.
    await expect(agent('register', '--api', 'http://fortress.example.com/api/v1', '--token', reg.body.token)).rejects.toMatchObject({ code: 2 });

    const registered = await agent('register', '--api', proxyBase, '--token', reg.body.token);
    expect(registered.stdout).toContain('Registered as "Real agent"');
    const agentId = /Agent id: ([0-9a-f-]{36})/.exec(registered.stdout)![1];
    const fingerprint = /Key fingerprint: ([0-9a-f ]{19})/.exec(registered.stdout)![1];

    // The token works once.
    await expect(agent('register', '--api', proxyBase, '--token', reg.body.token, '--replace')).rejects.toMatchObject({ code: 1 });
    expect((await agent('status')).stdout).toContain(agentId);

    const page = await api().get(`/api/v1/integrations/agents/${agentId}`).set(await as()).expect(200);
    expect(page.body.keys[0].fingerprint).toBe(fingerprint);

    startAgent();

    const online = await until('the agent to come online', async () => {
      const r = await api().get(`/api/v1/integrations/agents/${agentId}`).set(await as());
      return r.body.online && r.body;
    });
    expect(online.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(online.capabilities.jobs).toEqual(['diagnostics', 'discover', 'extract', 'ping', 'preview', 'rotate_keys', 'store_credential', 'test_connection', 'update_agent']);
    expect(online.capabilities.platform).toBe('linux-x64');
    expect(online.capabilities.adapters).toEqual(['folder', 'mysql', 'postgres', 'rest', 'sqlserver']);

    // Opening the agent's page wakes it to poll quickly, so the ping is answered within seconds.
    await api().post(`/api/v1/integrations/agents/${agentId}/wake`).set(await as()).expect(200);
    const ping = await api().post(`/api/v1/integrations/agents/${agentId}/ping`).set(await as()).send({}).expect(201);
    const done = await until('the ping to be answered', async () => {
      const r = await api().get(`/api/v1/integrations/agent-jobs/${ping.body.id}`).set(await as());
      return r.body.status === 'completed' && r.body;
    }, 60_000);
    expect(done.result).toMatchObject({ pong: true, version: online.version });
    expect(Math.abs(Date.parse(done.result.agentTime) - Date.now())).toBeLessThan(120_000);

    // AG6a: rotate the keys now. The agent tells Fortress of new keys and answers the job signed with them; the page shows the new fingerprint.
    const rot = await api().post(`/api/v1/integrations/agents/${agentId}/rotate-keys`).set(await as()).send({}).expect(201);
    const rotated = await until('the keys to be rotated', async () => {
      const r = await api().get(`/api/v1/integrations/agent-jobs/${rot.body.id}`).set(await as());
      if (r.body.status === 'failed') throw new Error(`rotation failed: ${r.body.errorMessage}\n${output}`);
      return r.body.status === 'completed' && r.body;
    }, 60_000);
    expect(rotated.result.fingerprint).not.toBe(fingerprint);
    const afterRotation = await api().get(`/api/v1/integrations/agents/${agentId}`).set(await as()).expect(200);
    expect(afterRotation.body.keys.find((k: { status: string }) => k.status === 'active').fingerprint).toBe(rotated.result.fingerprint);
    expect((await agent('status')).stdout).toContain(rotated.result.fingerprint);

    // A diagnostics bundle: bounded, with the new fingerprint, and nothing secret in it.
    const diag = await api().post(`/api/v1/integrations/agents/${agentId}/diagnostics`).set(await as()).send({}).expect(201);
    const bundle = await until('the diagnostics bundle', async () => {
      const r = await api().get(`/api/v1/integrations/agent-jobs/${diag.body.id}`).set(await as());
      return r.body.status === 'completed' && r.body.result;
    }, 60_000);
    expect(bundle).toMatchObject({ version: online.version, keyFingerprint: rotated.result.fingerprint, keyAgeDays: 0, rotationPending: false });
    expect(Buffer.byteLength(JSON.stringify(bundle))).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.stringify(bundle)).not.toContain(reg.body.token);

    await updates(agentId, online.version);

    // The database connection below seals its password to the new key, so it also proves the rotated sealing key works.
    if (pgPort) await databaseConnection(agentId);

    await api().post(`/api/v1/integrations/agents/${agentId}/revoke`).set(await as()).send({ reason: 'End of test' }).expect(200);
    const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 90_000))]);
    expect({ code, output: code === 0 ? '' : output }).toEqual({ code: 0, output: '' });
    expect(output).toContain('revoked');

    // Nothing secret in what the agent printed or logged.
    expect(output).not.toContain(reg.body.token);
  }, loadRows ? 8 * 3600_000 : 600_000);
});
