/**
 * Single sign-on SS1 through the API (docs/sso-plan.md): owners and admins claim email domains and prove them with a DNS TXT record the API looks up;
 * only the API records the outcome; one organisation holds a domain at a time; removing needs a reason; the weekly re-check flags a domain whose
 * record went. DNS is answered by a fake resolver (no network). The rules themselves are in supabase/tests/sso_domains.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { DnsTxtResolver } from '../src/sso/dns-txt';
import { SsoService } from '../src/sso/sso.service';
import { makeIds, requireDb, seed, testEnv, token } from './helpers';

class FakeDns extends DnsTxtResolver {
  records = new Map<string, string[]>();
  asked: string[] = [];
  async txt(name: string) {
    this.asked.push(name);
    const r = this.records.get(name);
    if (!r) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return r;
  }
}

const ids = makeIds('55a1');
const dns = new FakeDns();
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ss1');
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(DnsTxtResolver).useValue(dns).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, env);
  await app.init();
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('single sign-on domains', () => {
  let acme: { id: string; record: { type: string; name: string; value: string } };

  it('owners and admins only', async () => {
    await api().get('/api/v1/security/sso').set(await as(ids.inspectorA)).expect(403);
    await api().post('/api/v1/security/sso/domains').set(await as(ids.inspectorA)).send({ domain: 'acme-ss1.test' }).expect(403);
    const res = await api().get('/api/v1/security/sso').set(await as(ids.ownerA)).expect(200);
    expect(res.body).toMatchObject({ mode: 'off', join: 'invited', trustIdpMfa: true, canManage: true, domains: [] });
  });

  it('adds a domain with the record to publish, not yet verified', async () => {
    const res = await api().post('/api/v1/security/sso/domains').set(await as(ids.ownerA)).send({ domain: ' @ACME-SS1.test ' }).expect(201);
    acme = res.body.domains[0];
    expect(acme).toMatchObject({ domain: 'acme-ss1.test', state: 'unverified', record: { type: 'TXT', name: 'acme-ss1.test' } });
    expect(acme.record.value).toMatch(/^fortress-verification=[0-9a-f]{32}$/);
    const dup = await api().post('/api/v1/security/sso/domains').set(await as(ids.ownerA)).send({ domain: 'acme-ss1.test' }).expect(409);
    expect(dup.body.error).toMatchObject({ code: 'sso_rule', message: expect.stringMatching(/already on the list/) });
  });

  it('checks DNS: not there yet, then found', async () => {
    const first = await api().post(`/api/v1/security/sso/domains/${acme.id}/verify`).set(await as(ids.ownerA)).expect(201);
    expect(first.body.check).toEqual({ domainId: acme.id, outcome: 'unverified' });
    expect(first.body.domains[0]).toMatchObject({ state: 'unverified', checkError: expect.stringMatching(/was found at acme-ss1.test yet/) });
    expect(dns.asked).toContain('acme-ss1.test');

    dns.records.set('acme-ss1.test', ['v=spf1 -all', acme.record.value]);
    const ok = await api().post(`/api/v1/security/sso/domains/${acme.id}/verify`).set(await as(ids.ownerA)).expect(201);
    expect(ok.body.check.outcome).toBe('verified');
    expect(ok.body.domains[0]).toMatchObject({ state: 'verified', verifiedBy: 'Ada Owner', checkError: null });
  });

  it('another organisation cannot claim a domain held here, nor see or check this one', async () => {
    const taken = await api().post('/api/v1/security/sso/domains').set(await as(ids.ownerB, ids.orgB)).send({ domain: 'acme-ss1.test' }).expect(409);
    expect(taken.body.error.message).toMatch(/another organisation/);
    await api().post(`/api/v1/security/sso/domains/${acme.id}/verify`).set(await as(ids.ownerB, ids.orgB)).expect(404);
    await api().post(`/api/v1/security/sso/domains/${acme.id}/remove`).set(await as(ids.ownerB, ids.orgB)).send({ reason: 'Not yours' }).expect(404);
    const theirs = await api().get('/api/v1/security/sso').set(await as(ids.ownerB, ids.orgB)).expect(200);
    expect(theirs.body.domains).toEqual([]);
  });

  it('the weekly re-check flags a domain whose record went, and keeps it verified', async () => {
    await admin.query(`alter table public.organisation_sso_domains disable trigger organisation_sso_domains_touch`);
    await admin.query(`update public.organisation_sso_domains set last_checked_at = now() - interval '8 days' where id = $1`, [acme.id]);
    await admin.query(`alter table public.organisation_sso_domains enable trigger organisation_sso_domains_touch`);
    dns.records.delete('acme-ss1.test');
    const out = await app.get(SsoService).recheckDue('test-recheck', 50);
    expect(out).toMatchObject({ verified: 0 });
    expect(out.failing).toBeGreaterThanOrEqual(1);
    const res = await api().get('/api/v1/security/sso').set(await as(ids.ownerA)).expect(200);
    expect(res.body.domains[0]).toMatchObject({ state: 'failing', verifiedAt: expect.any(String), checkError: expect.stringMatching(/was found/) });
  });

  it('removes with a reason; kept in the list as removed', async () => {
    await api().post(`/api/v1/security/sso/domains/${acme.id}/remove`).set(await as(ids.ownerA)).send({ reason: 'x' }).expect(400);
    const res = await api().post(`/api/v1/security/sso/domains/${acme.id}/remove`).set(await as(ids.ownerA)).send({ reason: 'Wrong domain' }).expect(201);
    expect(res.body.domains[0]).toMatchObject({ state: 'removed', removedReason: 'Wrong domain', record: null, verifiedAt: null });
    const again = await api().post(`/api/v1/security/sso/domains/${acme.id}/verify`).set(await as(ids.ownerA)).expect(409);
    expect(again.body.error.code).toBe('sso_rule');
  });
});
