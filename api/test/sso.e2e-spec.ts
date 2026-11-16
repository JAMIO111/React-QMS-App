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
import { SamlMetadata, SsoAdminRefused, SsoProviderRecord, SupabaseSsoAdmin } from '../src/sso/supabase-sso-admin';
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

class FakeAdmin extends SupabaseSsoAdmin {
  on = true;
  providers = new Map<string, { metadata: SamlMetadata; domains: string[] }>();
  calls: string[] = [];
  failNext: Error | null = null;
  next = 1;
  get enabled() {
    return this.on;
  }
  private take() {
    const e = this.failNext;
    this.failNext = null;
    if (e) throw e;
  }
  async create(metadata: SamlMetadata, domains: string[]): Promise<SsoProviderRecord> {
    this.calls.push(`create ${domains.join(',')}`);
    this.take();
    const id = `00000000-0000-4000-8000-${String(this.next++).padStart(12, '0')}`;
    this.providers.set(id, { metadata, domains });
    return { id, entityId: 'https://idp.example.test/entity', domains };
  }
  async update(id: string, change: { metadata?: SamlMetadata; domains?: string[] }): Promise<SsoProviderRecord> {
    this.calls.push(`update ${change.metadata ? 'metadata ' : ''}${change.domains?.join(',') ?? ''}`);
    this.take();
    const p = this.providers.get(id)!;
    Object.assign(p, change.metadata ? { metadata: change.metadata } : {}, change.domains ? { domains: change.domains } : {});
    return { id, entityId: 'https://idp.example.test/entity', domains: p.domains };
  }
  async remove(id: string) {
    this.calls.push(`remove ${id}`);
    this.take();
    this.providers.delete(id);
  }
}

const ids = makeIds('55a1');
const dns = new FakeDns();
const sso = new FakeAdmin();
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ss1');
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(DnsTxtResolver).useValue(dns).overrideProvider(SupabaseSsoAdmin).useValue(sso).compile();
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

describe('the identity provider', () => {
  let beta: { id: string; record: { value: string } };
  const metadataUrl = 'https://login.example.test/federationmetadata.xml';

  it('says what IT enters, and needs a verified domain first', async () => {
    const res = await api().get('/api/v1/security/sso').set(await as(ids.ownerA)).expect(200);
    expect(res.body).toMatchObject({ available: true, provider: null, previousProviders: [] });
    expect(res.body.serviceProvider).toBeNull(); // no SUPABASE_URL in the tests; the values are unit-tested
    const none = await api().put('/api/v1/security/sso/provider').set(await as(ids.ownerA)).send({ metadataUrl }).expect(409);
    expect(none.body.error.message).toMatch(/Verify at least one email domain/);
    await api().put('/api/v1/security/sso/provider').set(await as(ids.inspectorA)).send({ metadataUrl }).expect(403);
  });

  it('refuses what is not metadata, before asking Supabase', async () => {
    await api().put('/api/v1/security/sso/provider').set(await as(ids.ownerA)).send({ metadataUrl: 'http://login.example.test/m.xml' }).expect(400);
    await api().put('/api/v1/security/sso/provider').set(await as(ids.ownerA)).send({ metadataXml: '<html>' + 'x'.repeat(60) + '</html>' }).expect(400);
    await api().put('/api/v1/security/sso/provider').set(await as(ids.ownerA)).send({ metadataUrl, metadataXml: 'x' }).expect(400);
  });

  it('connects the provider for the verified domains', async () => {
    const added = await api().post('/api/v1/security/sso/domains').set(await as(ids.ownerA)).send({ domain: 'beta-ss2.test' }).expect(201);
    beta = added.body.domains.find((d: { domain: string }) => d.domain === 'beta-ss2.test');
    dns.records.set('beta-ss2.test', [beta.record.value]);
    await api().post(`/api/v1/security/sso/domains/${beta.id}/verify`).set(await as(ids.ownerA)).expect(201);

    sso.failNext = new SsoAdminRefused('Unable to fetch SAML metadata');
    const refused = await api().put('/api/v1/security/sso/provider').set(await as(ids.ownerA)).send({ metadataUrl }).expect(409);
    expect(refused.body.error.message).toMatch(/Supabase did not accept it: Unable to fetch SAML metadata/);

    const res = await api().put('/api/v1/security/sso/provider').set(await as(ids.ownerA)).send({ metadataUrl }).expect(200);
    expect(res.body.provider).toMatchObject({ status: 'active', metadataKind: 'url', metadataUrl, domains: ['beta-ss2.test'], createdBy: 'Ada Owner', lastError: null });
    expect(sso.calls).toContain('create beta-ss2.test');
    expect([...sso.providers.values()][0].domains).toEqual(['beta-ss2.test']);
  });

  it('replaces the metadata of the same provider', async () => {
    const xml = '<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.test/entity"></EntityDescriptor>';
    const res = await api().put('/api/v1/security/sso/provider').set(await as(ids.ownerA)).send({ metadataXml: xml }).expect(200);
    expect(res.body.provider).toMatchObject({ metadataKind: 'xml', metadataUrl: null });
    expect(sso.providers.size).toBe(1);
  });

  it('keeps Supabase’s domains in step when a domain is verified or removed, and records a failed sync', async () => {
    const added = await api().post('/api/v1/security/sso/domains').set(await as(ids.ownerA)).send({ domain: 'gamma-ss2.test' }).expect(201);
    const gamma = added.body.domains.find((d: { domain: string }) => d.domain === 'gamma-ss2.test');
    dns.records.set('gamma-ss2.test', [gamma.record.value]);
    sso.failNext = new Error('Supabase answered 500');
    const failed = await api().post(`/api/v1/security/sso/domains/${gamma.id}/verify`).set(await as(ids.ownerA)).expect(201);
    expect(failed.body.provider).toMatchObject({ domains: ['beta-ss2.test'], lastError: 'Supabase answered 500' });
    // The next change sends the whole list again.
    const removed = await api().post(`/api/v1/security/sso/domains/${gamma.id}/remove`).set(await as(ids.ownerA)).send({ reason: 'Not ours after all' }).expect(201);
    expect(removed.body.provider).toMatchObject({ domains: ['beta-ss2.test'], lastError: null });
  });

  it('says so when this server cannot manage providers', async () => {
    sso.on = false;
    const res = await api().put('/api/v1/security/sso/provider').set(await as(ids.ownerA)).send({ metadataUrl }).expect(503);
    expect(res.body.error.code).toBe('sso_unavailable');
    expect((await api().get('/api/v1/security/sso').set(await as(ids.ownerA)).expect(200)).body.available).toBe(false);
    sso.on = true;
  });

  it('disconnects with a reason; kept in the history and gone from Supabase', async () => {
    await api().post('/api/v1/security/sso/provider/disable').set(await as(ids.ownerA)).send({ reason: 'x' }).expect(400);
    const res = await api().post('/api/v1/security/sso/provider/disable').set(await as(ids.ownerA)).send({ reason: 'Changing provider' }).expect(201);
    expect(res.body.provider).toBeNull();
    expect(res.body.previousProviders[0]).toMatchObject({ status: 'disabled', disabledReason: 'Changing provider', disabledBy: 'Ada Owner' });
    expect(sso.providers.size).toBe(0);
    await api().post('/api/v1/security/sso/provider/disable').set(await as(ids.ownerA)).send({ reason: 'Again' }).expect(409);
  });
});

describe('accepting the terms after a company sign-in', () => {
  it('records the version on the person’s own profile', async () => {
    await admin.query(`update public.profiles set terms_accepted_at = null, terms_version = null where id = $1`, [ids.inspectorA]);
    const before = await api().get('/api/v1/me').set({ Authorization: `Bearer ${await token(ids.inspectorA)}` }).expect(200);
    expect(before.body.profile).toMatchObject({ termsAcceptedAt: null, termsVersion: null });
    await api().post('/api/v1/me/terms').set({ Authorization: `Bearer ${await token(ids.inspectorA)}` }).send({ version: 'not valid!' }).expect(400);
    const after = await api().post('/api/v1/me/terms').set({ Authorization: `Bearer ${await token(ids.inspectorA)}` }).send({ version: '2026-11' }).expect(201);
    expect(after.body.profile).toMatchObject({ termsVersion: '2026-11', termsAcceptedAt: expect.any(String) });
  });
});

