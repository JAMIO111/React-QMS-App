/**
 * Email notifications (docs/email-oauth-plan.md, EM2) through the API: email choices in the preferences, the queue worked right after the request that caused
 * it (fake transport), the cron as the safety net in outbox-only mode, and the operator summary. The decisions about who gets what are the database's
 * (covered by supabase/tests/email_notifications.test.sql); this checks the wiring and the content.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { EmailService } from '../src/email/email.service';
import { MailMessage, MailOutcome, MailTransport } from '../src/email/mail-transport';
import { makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('e2');
const SECRET = 'cron-secret-for-email-tests-0123456789';
let app: INestApplication;
let admin: Pool;
let email: EmailService;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

class FakeTransport extends MailTransport {
  readonly name = 'fake';
  sent: MailMessage[] = [];
  next: MailOutcome['outcome'] | 'refuse' = 'sent';
  async send(message: MailMessage): Promise<MailOutcome> {
    if (this.next === 'refuse') return { outcome: 'failed', provider: this.name, error: 'Invalid address', retry: false };
    this.sent.push(message);
    return { outcome: 'sent', provider: this.name, messageId: `m-${this.sent.length}` };
  }
}
const transport = new FakeTransport();

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-email');
  await admin.query(`update auth.users set email_confirmed_at = now() where id = any($1::uuid[])`, [[ids.ownerA, ids.inspectorA, ids.dual]]);
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000', APP_BASE_URL: 'https://qms.example.com', CRON_SECRET: SECRET });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(MailTransport).useValue(transport).compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true }), env);
  await app.init();
  email = app.get(EmailService);
});

afterAll(async () => {
  await email?.settled();
  await app?.close();
  await admin?.end();
});

describe('email notifications', () => {
  // The suites share one database and run in no fixed order: notices other suites left behind must not count here, so each test starts with
  // everything from other organisations already considered.
  beforeEach(async () => {
    await admin.query(`update public.notifications set email_queued_at = now() where email_queued_at is null and organisation_id <> $1`, [ids.orgA]);
  });

  it('lists the email choice beside each event and says whether this server sends email', async () => {
    const res = await api().get('/api/v1/notification-preferences').set(await as(ids.dual)).expect(200);
    expect(res.body.email).toEqual({ sending: false });
    const part = res.body.data.find((p: { eventKey: string }) => p.eventKey === 'parts.created');
    expect(part).toMatchObject({ enabled: true, email: false, emailDefault: false, emailOverridden: false });
  });

  it('switches email on for one event without touching the in-app choice', async () => {
    await api().put('/api/v1/notification-preferences').set(await as(ids.dual)).send({ eventKey: 'parts.created' }).expect(400);
    const res = await api().put('/api/v1/notification-preferences').set(await as(ids.dual)).send({ eventKey: 'parts.created', email: true }).expect(200);
    expect(res.body.data.find((p: { eventKey: string }) => p.eventKey === 'parts.created')).toMatchObject({ enabled: true, overridden: false, email: true, emailOverridden: true });
  });

  it('emails right after the request that caused it, with a link to the record', async () => {
    email.autoKick = true;
    try {
      const created = await api().post('/api/v1/parts').set(await as(ids.ownerA)).send({ partNumber: 'EML-1', name: 'Emailed part' }).expect(201);
      await email.settled();
      const mine = transport.sent.filter((m) => m.to === `${ids.dual}@example.test`);
      expect(mine).toHaveLength(1);
      expect(mine[0].subject).toBe('Part created — EML-1 — Emailed part');
      expect(mine[0].text).toContain(`https://qms.example.com/Parts/${created.body.id}`);
      expect(mine[0].text).toContain('in Alpha Precision');
      expect(transport.sent.some((m) => m.to === `${ids.ownerA}@example.test`)).toBe(false);
      const row = (await admin.query(`select status, provider, provider_message_id from public.email_outbox where id = $1`, [mine[0].id])).rows[0];
      expect(row).toMatchObject({ status: 'sent', provider: 'fake' });
      // A read does not kick; nothing is sent twice.
      await api().get('/api/v1/parts').set(await as(ids.ownerA)).expect(200);
      await email.settled();
      expect(transport.sent.filter((m) => m.to === `${ids.dual}@example.test`)).toHaveLength(1);
    } finally {
      email.autoKick = false;
    }
  });

  it('a refusal that will not change is final at once', async () => {
    transport.next = 'refuse';
    await api().post('/api/v1/parts').set(await as(ids.ownerA)).send({ partNumber: 'EML-2', name: 'Refused part' }).expect(201);
    const r = await email.drain();
    expect(r).toMatchObject({ failed: 1, sent: 0 });
    transport.next = 'sent';
  });

  it('the cron works the queue too, and needs its secret', async () => {
    await request(app.getHttpServer()).post('/api/v1/internal/cron/email').expect(401);
    await api().post('/api/v1/parts').set(await as(ids.ownerA)).send({ partNumber: 'EML-3', name: 'Cron part' }).expect(201);
    const r = await request(app.getHttpServer()).post('/api/v1/internal/cron/email').set('Authorization', `Bearer ${SECRET}`).expect(200);
    expect(r.body).toMatchObject({ queued: 1, sent: 1, more: false });
  });

  it('the operator summary is for operators only', async () => {
    await api().get('/api/v1/platform/email').set(await as(ids.ownerA)).expect(404);
  });
});

describe('without a mail provider', () => {
  let plain: INestApplication;
  afterAll(async () => {
    await plain?.close();
  });

  it('keeps each email as it would have been sent, marked not sent', async () => {
    const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000', CRON_SECRET: SECRET });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
    plain = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true }), env);
    await plain.init();
    await request(plain.getHttpServer()).post('/api/v1/parts').set(await as(ids.ownerA)).send({ partNumber: 'EML-4', name: 'Unsent part' }).expect(201);
    const r = await request(plain.getHttpServer()).post('/api/v1/internal/cron/email').set('Authorization', `Bearer ${SECRET}`).expect(200);
    expect(r.body).toMatchObject({ queued: 1, unsent: 1, sent: 0 });
    const row = (await admin.query(`select e.status, e.provider, e.last_error from public.email_outbox e join public.notifications n on n.id = e.notification_id where n.body like 'EML-4%'`)).rows[0];
    expect(row).toEqual({ status: 'unsent', provider: 'none', last_error: 'No mail provider is set up (MAIL_PROVIDER)' });
  });
});
