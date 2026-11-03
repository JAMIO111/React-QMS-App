import { loadEnv } from '../config/env';
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
      expect(String(url)).toBe('https://p.supabase.co/auth/v1/invite?redirect_to=https%3A%2F%2Fapp.example%2Flogin');
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
  });
});
