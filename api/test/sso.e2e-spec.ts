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


/**
 * SS3: requiring the company sign-in (docs/sso-plan.md SS6–SS9). Tokens carry amr as Supabase writes it. In the database a session with no amr
 * (system work acting for a person) is not affected; over HTTP the 12-hour limit still asks such a token to sign in again. The rules themselves
 * are in supabase/tests/sso_enforcement.test.sql.
 */
describe('requiring the company sign-in', () => {
  let providerId: string;
  const password = (aal: 'aal1' | 'aal2' = 'aal1') => ({ aal, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] });
  const saml = () => ({ aal: 'aal1', amr: [{ method: 'sso/saml', provider: providerId, timestamp: Math.floor(Date.now() / 1000) }] });
  const with_ = async (user: string, claims: Record<string, unknown>) => ({ Authorization: `Bearer ${await token(user, claims)}`, 'X-Organisation-Id': ids.orgA });

  it('optional needs a connected provider; then passwords still work', async () => {
    const none = await api().put('/api/v1/security/sso/mode').set(await as(ids.ownerA)).send({ mode: 'optional' }).expect(409);
    expect(none.body.error.message).toMatch(/Connect your company/);
    const res = await api().put('/api/v1/security/sso/provider').set(await as(ids.ownerA)).send({ metadataUrl: 'https://login.example.test/ss3.xml' }).expect(200);
    providerId = res.body.provider.supabaseProviderId;
    await api().put('/api/v1/security/sso/mode').set(await as(ids.inspectorA)).send({ mode: 'optional' }).expect(403);
    const optional = await api().put('/api/v1/security/sso/mode').set(await as(ids.ownerA)).send({ mode: 'optional' }).expect(200);
    expect(optional.body).toMatchObject({ mode: 'optional', modeChangedBy: 'Ada Owner' });
    await api().get('/api/v1/ncrs').set(await with_(ids.inspectorA, password())).expect(200);
  });

  it('required needs confirming, and a request through the company sign-in', async () => {
    await api().put('/api/v1/security/sso/mode').set(await as(ids.ownerA)).send({ mode: 'required' }).expect(400);
    const refused = await api().put('/api/v1/security/sso/mode').set(await with_(ids.ownerA, password('aal2'))).send({ mode: 'required', confirm: true }).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'sso_rule', message: expect.stringMatching(/Sign in with your company account first/) });
    const res = await api().put('/api/v1/security/sso/mode').set(await with_(ids.ownerA, saml())).send({ mode: 'required', confirm: true }).expect(200);
    expect(res.body).toMatchObject({ mode: 'required', session: { viaSso: true }, sessionHours: { stored: null, effective: 12 } });
    expect(res.body.changes[0]).toMatchObject({ kind: 'mode', from: 'optional', to: 'required', by: 'Ada Owner' });
    expect(res.body.passwordMembers.map((m: { userId: string }) => m.userId)).toEqual(expect.arrayContaining([ids.ownerA, ids.inspectorA]));
  });

  it('refuses a password session with 403 sso_required, on every organisation route', async () => {
    const res = await api().get('/api/v1/ncrs').set(await with_(ids.inspectorA, password('aal2'))).expect(403);
    expect(res.body.error).toMatchObject({ code: 'sso_required', details: { providerId, breakGlass: false } });
    const me = await api().get('/api/v1/me').set({ Authorization: `Bearer ${await token(ids.inspectorA, password())}` }).expect(200);
    expect(me.body.sso.requiredBy).toEqual([expect.objectContaining({ id: ids.orgA, providerId, breakGlass: false })]);
    expect(me.body.memberships.map((m: { organisation: { id: string } }) => m.organisation.id)).not.toContain(ids.orgA);
    expect(me.body.mfa.requiredBy).toEqual([]);
  });

  it('lets in a request through the organisation’s own provider, wherever it is in amr, and records the sign-in', async () => {
    await api().get('/api/v1/ncrs').set(await with_(ids.inspectorA, saml())).expect(200);
    const both = { aal: 'aal2', amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }, ...saml().amr] };
    await api().get('/api/v1/ncrs').set(await with_(ids.inspectorA, both)).expect(200);
    const other = { aal: 'aal1', amr: [{ method: 'sso/saml', provider: '00000000-0000-4000-8000-0000000000ff' }] };
    expect((await api().get('/api/v1/ncrs').set(await with_(ids.inspectorA, other)).expect(403)).body.error.code).toBe('sso_required');
    const rows = await admin.query(`select method, count from public.sso_sign_ins where organisation_id = $1 and user_id = $2`, [ids.orgA, ids.inspectorA]);
    expect(rows.rows).toEqual([{ method: 'sso', count: 1 }]); // once an hour per process, however many requests
  });

  it('applies the 12-hour session limit while required (a token that does not say when it signed in is asked to sign in again)', async () => {
    const res = await api().get('/api/v1/ncrs').set(await as(ids.inspectorA)).expect(401);
    expect(res.body.error).toMatchObject({ code: 'reauthentication_required', details: { maxSessionHours: 12 } });
    const old = { aal: 'aal1', amr: [{ method: 'sso/saml', provider: providerId, timestamp: Math.floor(Date.now() / 1000) - 13 * 3600 }] };
    expect((await api().get('/api/v1/ncrs').set(await with_(ids.inspectorA, old)).expect(401)).body.error.code).toBe('reauthentication_required');
  });

  it('break-glass: an owner gets in with a password AND two-factor, never a password alone, and owners are told', async () => {
    await api().put('/api/v1/security/sso/break-glass').set(await with_(ids.ownerA, saml())).send({ userIds: [ids.inspectorA] }).expect(409);
    const res = await api().put('/api/v1/security/sso/break-glass').set(await with_(ids.ownerA, saml())).send({ userIds: [ids.ownerA] }).expect(200);
    expect(res.body.breakGlass).toEqual([expect.objectContaining({ userId: ids.ownerA, name: 'Ada Owner' })]);
    const alone = await api().get('/api/v1/ncrs').set(await with_(ids.ownerA, password('aal1'))).expect(403);
    expect(alone.body.error).toMatchObject({ code: 'sso_required', details: { breakGlass: true } });
    await api().get('/api/v1/ncrs').set(await with_(ids.ownerA, password('aal2'))).expect(200);
    const used = await admin.query(`select count(*)::int as n from public.sso_changes where organisation_id = $1 and kind = 'break_glass_used'`, [ids.orgA]);
    expect(used.rows[0].n).toBe(1);
  });

  it('keeps the provider while single sign-on is in use, without asking Supabase', async () => {
    const before = sso.calls.length;
    const res = await api().post('/api/v1/security/sso/provider/disable').set(await with_(ids.ownerA, saml())).send({ reason: 'Changing provider' }).expect(409);
    expect(res.body.error.message).toMatch(/Switch single sign-on off/);
    expect(sso.calls.length).toBe(before);
  });

  it('invites only at the verified domains, and never with a password invitation', async () => {
    const role = (await admin.query(`select id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA])).rows[0].id;
    const outside = await api().post('/api/v1/members/invitations').set(await with_(ids.ownerA, saml())).send({ email: 'guest@elsewhere-ss3.test', roleId: role }).expect(409);
    expect(outside.body.error.message).toMatch(/requires single sign-on/);
    const inside = await api().post('/api/v1/members/invitations').set(await with_(ids.ownerA, saml())).send({ email: 'new.person@beta-ss2.test', roleId: role }).expect(201);
    expect(inside.body.email).toEqual({ sent: false, reason: 'company_sign_in' });
  });

  it('switching a company sign-in’s two-factor trust off is refused from a session that would then fail', async () => {
    await admin.query(`update public.organisation_settings set require_mfa = true where organisation_id = $1`, [ids.orgA]);
    const refused = await api().put('/api/v1/security/sso/two-factor').set(await with_(ids.ownerA, saml())).send({ trust: false }).expect(409);
    expect(refused.body.error.message).toMatch(/Set up two-factor/);
    await admin.query(`update public.organisation_settings set require_mfa = false where organisation_id = $1`, [ids.orgA]);
  });

  it('an operator with MFA can make it optional again', async () => {
    await admin.query(`insert into public.platform_admins (user_id, note) values ($1, 'operator') on conflict do nothing`, [ids.outsider]);
    const body = { reason: 'The certificate expired overnight', verification: 'Called the owner back on file' };
    const auth = { Authorization: `Bearer ${await token(ids.outsider, { aal: 'aal2' })}` };
    const res = await api().post(`/api/v1/platform/organisations/${ids.orgA}/recover-sso`).set(auth).send(body).expect(200);
    expect(res.body).toMatchObject({ organisationId: ids.orgA, ssoMode: 'optional' });
    const list = await api().get('/api/v1/platform/organisations').set(auth).expect(200);
    expect(list.body.data.find((o: { organisationId: string }) => o.organisationId === ids.orgA).sso).toEqual({ mode: 'optional', connected: true });
    await api().get('/api/v1/ncrs').set(await with_(ids.inspectorA, password())).expect(200);
    await api().put('/api/v1/security/sso/mode').set(await as(ids.ownerA)).send({ mode: 'off' }).expect(200);
  });
});
