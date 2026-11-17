import { apiFieldName, rowsOf, takeExpectedVersion } from './versioned';

describe('takeExpectedVersion', () => {
  it('reads rowVersion from the body and removes it, so a strict body schema never sees it', () => {
    const req = { headers: {}, body: { title: 'x', rowVersion: '1767261600123456' } };
    expect(takeExpectedVersion(req)).toBe('1767261600123456');
    expect(req.body).toEqual({ title: 'x' });
  });

  it('reads If-Match, quoted or weak', () => {
    expect(takeExpectedVersion({ headers: { 'if-match': '"42"' } })).toBe('42');
    expect(takeExpectedVersion({ headers: { 'if-match': 'W/"42"' } })).toBe('42');
    expect(takeExpectedVersion({ headers: { 'if-match': '42' } })).toBe('42');
  });

  it('prefers the body, and ignores anything that is not a version', () => {
    expect(takeExpectedVersion({ headers: { 'if-match': '"1"' }, body: { rowVersion: '2' } })).toBe('2');
    expect(takeExpectedVersion({ headers: { 'if-match': '"*"' } })).toBeNull();
    const req = { headers: {}, body: { rowVersion: 'drop table' } };
    expect(takeExpectedVersion(req)).toBeNull();
    expect(req.body).toEqual({});
    expect(takeExpectedVersion({ headers: {}, body: [1, 2] })).toBeNull();
    expect(takeExpectedVersion({ headers: {} })).toBeNull();
  });
});

describe('apiFieldName', () => {
  it('turns columns into the names the API uses', () => {
    expect(apiFieldName('title')).toBe('title');
    expect(apiFieldName('quantity_affected')).toBe('quantityAffected');
    expect(apiFieldName('d2_how_many')).toBe('d2HowMany');
    expect(apiFieldName('owner_user_id')).toBe('ownerId');
  });
});

describe('rowsOf', () => {
  const a = { id: '11111111-2222-3333-4444-555555555555' };
  it('finds the rows of a register answer', () => {
    expect(rowsOf({ data: [a, { id: 'x' }, null] })).toEqual([a]);
    expect(rowsOf({ items: [a] })).toEqual([a]);
    expect(rowsOf([a])).toEqual([a]);
    expect(rowsOf({ revisions: [a], data: [] }, 'revisions')).toEqual([a]);
    expect(rowsOf(null)).toEqual([]);
  });
});
