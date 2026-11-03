import type { Response } from 'express';
import { ApiRequest, contextFrom, resolveCorrelationId } from './request-context';

const req = (headers: Record<string, string> = {}) => ({ headers }) as unknown as ApiRequest;
const res = () => {
  const headers: Record<string, string> = {};
  return { headersSent: false, setHeader: (k: string, v: string) => (headers[k] = v), headers } as unknown as Response & { headers: Record<string, string> };
};

describe('resolveCorrelationId', () => {
  it('keeps a well-formed incoming id and echoes it', () => {
    const r = res();
    expect(resolveCorrelationId(req({ 'x-correlation-id': 'abc-123' }), r)).toBe('abc-123');
    expect(r.headers['X-Correlation-Id']).toBe('abc-123');
  });

  it('replaces malformed ids with a generated UUID', () => {
    const id = resolveCorrelationId(req({ 'x-correlation-id': 'bad id <script>' }));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is stable for the same request', () => {
    const r = req();
    expect(resolveCorrelationId(r)).toBe(resolveCorrelationId(r));
  });
});

describe('contextFrom', () => {
  it('trims and limits the change reason', () => {
    const r = req({ 'x-change-reason': `  ${'x'.repeat(600)}  ` });
    r.user = { id: 'u', claims: {} };
    expect(contextFrom(r).reason).toHaveLength(500);
  });

  it('refuses unauthenticated requests', () => {
    expect(() => contextFrom(req())).toThrow();
  });
});
