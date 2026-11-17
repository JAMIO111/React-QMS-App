import { loadEnv } from '../config/env';
import { MailMessage, MailTransport } from '../email/mail-transport';
import { InvitationMailer } from './invitation-mailer.service';

const base = { DATABASE_URL: 'postgres://x', SUPABASE_JWT_SECRET: 'x'.repeat(40) };

describe('InvitationMailer', () => {
  it('does nothing when not configured', async () => {
    const mailer = new InvitationMailer(loadEnv(base));
    const fetchImpl = jest.fn();
    await expect(mailer.send('a@example.test', 'Acme', fetchImpl)).resolves.toEqual({ sent: false, reason: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('when configured', () => {
    const mailer = new InvitationMailer(
      loadEnv({ ...base, SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value', INVITE_REDIRECT_URL: 'https://app.example/login' }),
    );

    it('calls the Supabase admin invite endpoint with the service key and redirect', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      await expect(mailer.send('a@example.test', 'Acme', fetchImpl)).resolves.toEqual({ sent: true });
      const [url, init] = fetchImpl.mock.calls[0];
      // the link lands on the confirm page (the token is used only when the person presses Continue), then goes on to set a password
      expect(String(url)).toBe('https://p.supabase.co/auth/v1/invite?redirect_to=' + encodeURIComponent('https://app.example/auth/confirm?next=%2Fset-password%3Fmode%3Dinvite'));
      expect(init.headers).toMatchObject({ apikey: 'service-role-key-value', Authorization: 'Bearer service-role-key-value' });
      expect(JSON.parse(init.body)).toEqual({ email: 'a@example.test', data: { invited_to: 'Acme' } });
    });

    it('reports existing accounts and failures without throwing', async () => {
      await expect(mailer.send('a@example.test', 'Acme', jest.fn().mockResolvedValue(new Response('{}', { status: 422 })))).resolves.toEqual({
        sent: false,
        reason: 'existing_account',
      });
      await expect(mailer.send('a@example.test', 'Acme', jest.fn().mockResolvedValue(new Response('{}', { status: 500 })))).resolves.toEqual({
        sent: false,
        reason: 'send_failed',
      });
      await expect(mailer.send('a@example.test', 'Acme', jest.fn().mockRejectedValue(new Error('network')))).resolves.toEqual({
        sent: false,
        reason: 'send_failed',
      });
    });

    it('sends an existing account a sign-in link that lands on the confirm page, then /accept-invite', async () => {
      const fetchImpl = jest.fn().mockResolvedValueOnce(new Response('{}', { status: 422 })).mockResolvedValueOnce(new Response('{}', { status: 200 }));
      await expect(mailer.send('a@example.test', 'Acme', fetchImpl)).resolves.toEqual({ sent: true, kind: 'sign_in_link' });
      const [url, init] = fetchImpl.mock.calls[1];
      expect(String(url)).toBe('https://p.supabase.co/auth/v1/otp?redirect_to=' + encodeURIComponent('https://app.example/auth/confirm?next=%2Faccept-invite'));
      expect(init.headers).toMatchObject({ apikey: 'service-role-key-value' });
      expect(JSON.parse(init.body)).toEqual({ email: 'a@example.test', create_user: false });
    });

    it('uses APP_BASE_URL for the landing page when it is set', () => {
      const withBase = new InvitationMailer(loadEnv({ ...base, SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value', APP_BASE_URL: 'https://web.example/' }));
      expect(withBase.acceptUrl()).toBe('https://web.example/auth/confirm?next=%2Faccept-invite');
      expect(new InvitationMailer(loadEnv(base)).acceptUrl()).toBeUndefined();
    });

    it('says the account exists when there is nowhere to send the link or the link fails', async () => {
      const noWhere = new InvitationMailer(loadEnv({ ...base, SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value' }));
      const only422 = jest.fn().mockResolvedValue(new Response('{}', { status: 422 }));
      await expect(noWhere.send('a@example.test', 'Acme', only422)).resolves.toEqual({ sent: false, reason: 'existing_account' });
      expect(only422).toHaveBeenCalledTimes(1);
      const linkFails = jest.fn().mockResolvedValueOnce(new Response('{}', { status: 422 })).mockRejectedValueOnce(new Error('network'));
      await expect(mailer.send('a@example.test', 'Acme', linkFails)).resolves.toEqual({ sent: false, reason: 'existing_account' });
    });
  });

  describe('someone who signs in with their company account (SSO)', () => {
    class Recorder extends MailTransport {
      readonly name = 'resend';
      sent: MailMessage[] = [];
      async send(m: MailMessage) {
        this.sent.push(m);
        return { outcome: 'sent' as const, provider: this.name };
      }
    }
    const env = loadEnv({ ...base, SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value', APP_BASE_URL: 'https://web.example/' });

    it('emails a link to the company sign-in through the mail provider, never a Supabase invitation', async () => {
      const transport = new Recorder();
      const mailer = new InvitationMailer(env, transport);
      await expect(mailer.sendCompanySignIn('new@acme.test', 'Acme <Ltd>', 'acme.test')).resolves.toEqual({ sent: true, kind: 'company_sign_in' });
      expect(transport.sent[0]).toMatchObject({ to: 'new@acme.test', subject: "You're invited to join Acme <Ltd> on Fortress QMS" });
      expect(transport.sent[0].text).toContain('https://web.example/sso?domain=acme.test');
      expect(transport.sent[0].html).toContain('Acme &lt;Ltd&gt;');
    });

    it('sends nothing without a mail provider or an app address: the invitation waits for them', async () => {
      await expect(new InvitationMailer(env).sendCompanySignIn('new@acme.test', 'Acme', 'acme.test')).resolves.toEqual({ sent: false, reason: 'company_sign_in' });
      await expect(new InvitationMailer(loadEnv(base), new Recorder()).sendCompanySignIn('new@acme.test', 'Acme', 'acme.test')).resolves.toEqual({
        sent: false,
        reason: 'company_sign_in',
      });
    });
  });

  describe('with a mail provider: its own branded email, and a link only a person can use', () => {
    class Recorder extends MailTransport {
      readonly name = 'resend';
      sent: MailMessage[] = [];
      async send(m: MailMessage) {
        this.sent.push(m);
        return { outcome: 'sent' as const, provider: this.name };
      }
    }
    const env = loadEnv({ ...base, SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value', APP_BASE_URL: 'https://web.example/' });
    const details = { inviterName: 'Olivia Owner', message: 'Welcome to the quality team <3', roleName: 'Quality engineer', expiresAt: '2026-12-01T10:00:00Z' };

    it('makes the link without Supabase sending anything, and emails a link to the confirm page', async () => {
      const transport = new Recorder();
      const mailer = new InvitationMailer(env, transport);
      const fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({ hashed_token: 'abc123' }), { status: 200 }));
      await expect(mailer.send('new@acme.test', 'Acme Ltd', fetchImpl, details)).resolves.toEqual({ sent: true });
      const [url, init] = fetchImpl.mock.calls[0];
      expect(String(url)).toBe('https://p.supabase.co/auth/v1/admin/generate_link');
      expect(JSON.parse(init.body)).toMatchObject({ type: 'invite', email: 'new@acme.test', redirect_to: 'https://web.example/auth/confirm?next=%2Fset-password%3Fmode%3Dinvite' });
      const mail = transport.sent[0];
      expect(mail.to).toBe('new@acme.test');
      expect(mail.subject).toBe('Olivia Owner invited you to join Acme Ltd on Fortress QMS');
      const link = 'https://web.example/auth/confirm?token_hash=abc123&type=invite&next=%2Fset-password%3Fmode%3Dinvite';
      expect(mail.text).toContain(`Accept invitation: ${link}`);
      expect(mail.html).toContain(link.replace(/&/g, '&amp;'));
      // who, the message (escaped), the role and the expiry, and the logo from the app
      expect(mail.html).toContain('Olivia Owner');
      expect(mail.html).toContain('Welcome to the quality team &lt;3');
      expect(mail.html).toContain('Quality engineer');
      expect(mail.html).toContain('1 December 2026');
      expect(mail.html).toContain('https://web.example/fortress-qms.png');
      expect(mail.html).not.toContain('<3');
    });

    it('someone who already has an account gets a sign-in link that goes on to the invitation', async () => {
      const transport = new Recorder();
      const mailer = new InvitationMailer(env, transport);
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(new Response('{"code":422}', { status: 422 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ properties: { hashed_token: 'def456' } }), { status: 200 }));
      await expect(mailer.send('known@acme.test', 'Acme Ltd', fetchImpl, details)).resolves.toEqual({ sent: true, kind: 'sign_in_link' });
      expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({ type: 'magiclink', email: 'known@acme.test' });
      expect(transport.sent[0].text).toContain('Sign in and accept: https://web.example/auth/confirm?token_hash=def456&type=magiclink&next=%2Faccept-invite');
    });

    it('a refused link or a failed send is reported, never thrown', async () => {
      const transport = new Recorder();
      const mailer = new InvitationMailer(env, transport);
      await expect(mailer.send('x@acme.test', 'Acme', jest.fn().mockResolvedValue(new Response('{}', { status: 500 })), details)).resolves.toEqual({ sent: false, reason: 'send_failed' });
      await expect(mailer.send('x@acme.test', 'Acme', jest.fn().mockRejectedValue(new Error('network')), details)).resolves.toEqual({ sent: false, reason: 'send_failed' });
      expect(transport.sent).toHaveLength(0);
    });
  });
});
