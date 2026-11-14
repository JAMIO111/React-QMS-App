/**
 * Which address the API checks (docs/security-plan.md S2, SE0). With one trusted proxy hop (production behind Vercel) it is the address the
 * proxy put last in X-Forwarded-For, so a value the browser sent in front of it is ignored; with no trusted hop the header is ignored entirely.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startApp } from './helpers';

let behindProxy: INestApplication;
let direct: INestApplication;

beforeAll(async () => {
  behindProxy = await startApp({ NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' });
  direct = await startApp({ TRUST_PROXY_HOPS: '0' });
});
afterAll(async () => {
  await Promise.all([behindProxy?.close(), direct?.close()]);
});

describe('the address the API checks', () => {
  it('behind one proxy hop: the address the proxy added, not one the browser forged in front of it', async () => {
    const res = await request(behindProxy.getHttpServer()).get('/api/v1/health/network').set('X-Forwarded-For', '6.6.6.6, 203.0.113.9').expect(200);
    expect(res.body).toMatchObject({ address: '203.0.113.9', trustProxy: 1 });
    const v6 = await request(behindProxy.getHttpServer()).get('/api/v1/health/network').set('X-Forwarded-For', '2001:DB8::7').expect(200);
    expect(v6.body.address).toBe('2001:db8::7');
  });

  it('with no trusted hop: forwarding headers are ignored and the connection’s own address is used', async () => {
    const res = await request(direct.getHttpServer()).get('/api/v1/health/network').set('X-Forwarded-For', '6.6.6.6').set('X-Real-IP', '6.6.6.6').expect(200);
    expect(res.body.address).toMatch(/^(127\.0\.0\.1|::1)$/);
    expect(res.body.headers['x-forwarded-for']).toBe('6.6.6.6');
  });
});
