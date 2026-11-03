import { apiErrorFromDatabase } from './database-errors';

const pg = (code: string, constraint?: string) => Object.assign(new Error('db'), { code, constraint });

describe('apiErrorFromDatabase', () => {
  it.each([
    ['23505', 409, 'conflict'],
    ['23503', 400, 'invalid_reference'],
    ['23514', 400, 'invalid_value'],
    ['42501', 403, 'forbidden'],
    ['54000', 429, 'limit_reached'],
    ['57014', 503, 'timeout'],
  ])('maps SQLSTATE %s to %i %s', (code, status, apiCode) => {
    const e = apiErrorFromDatabase(pg(code));
    expect(e?.getStatus()).toBe(status);
    expect(e?.code).toBe(apiCode);
  });

  it('uses friendly messages for known unique constraints', () => {
    expect(apiErrorFromDatabase(pg('23505', 'sites_org_code_key'))?.message).toBe('A site with this code already exists');
  });

  it('unwraps errors wrapped by Drizzle (cause)', () => {
    const wrapped = Object.assign(new Error('Failed query'), { cause: pg('23505') });
    expect(apiErrorFromDatabase(wrapped)?.code).toBe('conflict');
  });

  it('ignores unknown and non-database errors (they become internal errors without details)', () => {
    expect(apiErrorFromDatabase(pg('XX000'))).toBeUndefined();
    expect(apiErrorFromDatabase(new Error('boom'))).toBeUndefined();
    expect(apiErrorFromDatabase(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBeUndefined();
  });
});
