/**
 * API hardening (audit report M1 to M4): the reference page is off in production, security headers are sent, a request that is too large is
 * refused with 413 (not 500), and the rate limit counts each client address behind a proxy separately.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startApp } from './helpers';

let dev: INestApplication;
let prod: INestApplication;
let limited: INestApplication;
const call = (app: INestApplication) => request(app.getHttpServer());

beforeAll(async () => {
  dev = await startApp();
  prod = await startApp({ NODE_ENV: 'production' });
  limited = await startApp({ NODE_ENV: 'production', RATE_LIMIT_PER_MINUTE: '2' });
});
afterAll(async () => {
  await Promise.all([dev?.close(), prod?.close(), limited?.close()]);
});

describe('reference page', () => {
  it('is served outside production', async () => {
    await call(dev).get('/api/v1/openapi.json').expect(200);
  });

  it('is not served in production unless API_DOCS=true', async () => {
    await call(prod).get('/api/v1/docs').expect(404);
    await call(prod).get('/api/v1/openapi.json').expect(404);
  });

  it('can be switched on in production', async () => {
    const on = await startApp({ NODE_ENV: 'production', API_DOCS: 'true' });
    try {
      await call(on).get('/api/v1/openapi.json').expect(200);
    } finally {
      await on.close();
    }
  });
});

describe('response headers', () => {
  it('sends the standard security headers', async () => {
    const res = await call(prod).get('/api/v1/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('request size', () => {
  it('answers 413 with the standard error for a body over the limit', async () => {
    const res = await call(dev).post('/api/v1/ncrs').set('Content-Type', 'application/json').send(JSON.stringify({ title: 'x'.repeat(2_000_000) })).expect(413);
    expect(res.body.error).toMatchObject({ code: 'payload_too_large', correlationId: expect.any(String) });
  });
});

describe('rate limit behind a proxy', () => {
  it('counts each client address separately (X-Forwarded-For), not the proxy as one caller', async () => {
    const hit = (ip: string) => call(limited).get('/api/v1/me').set('X-Forwarded-For', ip);
    expect((await hit('203.0.113.1')).status).toBe(401);
    expect((await hit('203.0.113.1')).status).toBe(401);
    expect((await hit('203.0.113.1')).status).toBe(429);
    // Another client is not affected.
    expect((await hit('203.0.113.2')).status).toBe(401);
  });
});
