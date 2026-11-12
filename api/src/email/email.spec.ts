import { notificationPath, renderNotificationEmail, EmailRow } from './email-content';
import { mailTransportFor, OutboxOnlyTransport, ResendTransport } from './mail-transport';
import type { Env } from '../config/env';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const row = (over: Partial<EmailRow> = {}): EmailRow => ({
  id: 'e1', organisation_name: 'Acme Ltd', to_address: 'ada@example.com', recipient_name: 'Ada Owner', event_key: 'nonconformances.created',
  entity_type: 'nonconformances', entity_id: A, title: 'Non-conformance created', body: 'NCR-26-0001 — Burr on bore', details: {}, created_at: '2026-11-11T09:30:00Z', ...over,
});

describe('where an email links to', () => {
  it('follows the in-app links, and goes to the run for an import alert', () => {
    expect(notificationPath('nonconformances', A, {})).toBe(`/Non-Conformance/Register/${A}`);
    expect(notificationPath('nonconformances', A, { deleted: true })).toBeNull();
    expect(notificationPath('calibrations', A, { gauge_id: B })).toBe(`/Calibration/Gauges/${B}/calibrations/${A}`);
    expect(notificationPath('quality_alert_recipients', A, { alert_id: B })).toBe(`/Documentation/Quality-Alerts/${B}`);
    expect(notificationPath('capa_actions', A, {})).toBe('/CAPA/My-Actions');
    expect(notificationPath('risks', A, {})).toBe(`/Risk/Register/${A}`);
    expect(notificationPath('management_review_actions', A, { review_id: B })).toBe('/Management-Review/My-Actions');
    expect(notificationPath('risk_actions', A, { risk_id: B })).toBe(`/Risk/Register/${B}`);
    expect(notificationPath('risk_actions', A, { risk_id: 'not-an-id' })).toBe('/Risk/My-Work');
    expect(notificationPath('integration_alerts', A, { connection_id: A, run_id: B })).toBe(`/Settings/Integrations/${A}/runs/${B}`);
    expect(notificationPath('integration_alerts', A, {})).toBe('/Settings/Integrations');
    expect(notificationPath('something_else', A, {})).toBeNull();
  });

  it('never builds a path from text that is not an id', () => {
    expect(notificationPath('parts', '../../evil', {})).toBeFalsy();
    expect(notificationPath('calibrations', A, { gauge_id: '//evil.example.com' })).toBeNull();
    expect(notificationPath('integration_alerts', A, { connection_id: 'x/../../y', run_id: B })).toBe('/Settings/Integrations');
  });
});

describe('the email', () => {
  it('says what happened, where, and links to it', () => {
    const e = renderNotificationEmail(row(), 'https://qms.example.com');
    expect(e.subject).toBe('Non-conformance created — NCR-26-0001 — Burr on bore');
    expect(e.link).toBe(`https://qms.example.com/Non-Conformance/Register/${A}`);
    expect(e.text).toContain('Hello Ada Owner,');
    expect(e.text).toContain('Non-conformance created in Acme Ltd.');
    expect(e.text).toContain(`Open it in Fortress QMS: https://qms.example.com/Non-Conformance/Register/${A}`);
    expect(e.text).toContain('https://qms.example.com/Settings/Notifications');
    expect(e.html).toContain(`href="https://qms.example.com/Non-Conformance/Register/${A}"`);
  });

  it('escapes what came from the database and keeps the subject on one line', () => {
    const e = renderNotificationEmail(row({ title: 'Part created\r\nBcc: x@y.z', body: '<script>alert(1)</script> & "q"', organisation_name: 'A <b>Co</b>', recipient_name: null }), undefined);
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(e.subject).toBe('Part created Bcc: x@y.z — <script>alert(1)</script> & "q"');
    expect(e.html).not.toContain('<script>');
    expect(e.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;');
    expect(e.html).toContain('A &lt;b&gt;Co&lt;/b&gt;');
    expect(e.text.startsWith('Hello,')).toBe(true);
    expect(e.link).toBeNull();
    expect(e.text).toContain('Open Fortress QMS to see it.');
  });

  it('bounds a long subject', () => {
    expect(renderNotificationEmail(row({ body: 'x'.repeat(1000) }), undefined).subject.length).toBeLessThanOrEqual(180);
  });
});

describe('sending', () => {
  const env = (over: Partial<Env>) => ({ MAIL_PROVIDER: 'none', ...over }) as Env;
  const msg = { id: 'e1', to: 'ada@example.com', subject: 'S', text: 'T', html: '<p>T</p>' };

  it('without a provider keeps the email as not sent', async () => {
    const t = mailTransportFor(env({}));
    expect(t).toBeInstanceOf(OutboxOnlyTransport);
    expect(await t.send(msg)).toEqual({ outcome: 'unsent', provider: 'none', reason: expect.stringMatching(/No mail provider/) });
    expect(mailTransportFor(env({ MAIL_PROVIDER: 'resend' }))).toBeInstanceOf(OutboxOnlyTransport);
  });

  it('posts to Resend with the key, the sender and an idempotency key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const t = mailTransportFor(env({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key_123', MAIL_FROM: 'Fortress <alerts@example.com>' }), fake);
    expect(t).toBeInstanceOf(ResendTransport);
    expect(await t.send(msg)).toEqual({ outcome: 'sent', provider: 'resend', messageId: 'msg_1' });
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer re_test_key_123');
    expect(headers['Idempotency-Key']).toBe('fortress-e1');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ from: 'Fortress <alerts@example.com>', to: ['ada@example.com'], subject: 'S', text: 'T', html: '<p>T</p>' });
  });

  it('retries outages and rate limits, not refusals', async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await new ResendTransport('re_x', 'a@b.co', answer(429, { message: 'Too many requests' })).send(msg)).toMatchObject({ outcome: 'failed', retry: true });
    expect(await new ResendTransport('re_x', 'a@b.co', answer(502, {})).send(msg)).toMatchObject({ outcome: 'failed', retry: true });
    expect(await new ResendTransport('re_x', 'a@b.co', answer(422, { message: 'Invalid `to` field' })).send(msg)).toEqual({
      outcome: 'failed', provider: 'resend', retry: false, error: 'Resend refused it (422): Invalid `to` field',
    });
    const down = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    expect(await new ResendTransport('re_x', 'a@b.co', down).send(msg)).toMatchObject({ outcome: 'failed', retry: true, error: expect.stringMatching(/could not be reached: ECONNRESET/) });
  });
});
