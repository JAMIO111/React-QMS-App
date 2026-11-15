import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { agentCellText, agentRowText, MAX_INFLATED_BYTES, readAgentBatch } from './agent-batch';

const pack = (body: unknown) => {
  const json = Buffer.from(JSON.stringify(body));
  return { gz: gzipSync(json), sum: createHash('sha256').update(json).digest('hex') };
};
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return `${(e as { status?: number }).status} ${(e as { code?: string }).code}`;
  }
};

describe('a batch of rows from a connector agent', () => {
  it('is inflated, its checksum checked and its shape read', () => {
    const { gz, sum } = pack({ seq: 3, lastKey: 'M9', rows: [{ code: 'M9', qty: '1.500', due: '2026-01-02', active: true, notes: null }] });
    const b = readAgentBatch(gz, sum.toUpperCase());
    expect(b).toEqual({ seq: 3, lastKey: 'M9', rows: [{ code: 'M9', qty: '1.500', due: '2026-01-02', active: true, notes: null }], checksum: sum });
  });

  it('refuses rows that do not match the checksum, bad gzip and bad shapes', () => {
    const { gz, sum } = pack({ seq: 0, lastKey: null, rows: [] });
    expect(code(() => readAgentBatch(gz, 'a'.repeat(64)))).toBe('400 batch_checksum');
    expect(code(() => readAgentBatch(gz, undefined))).toBe('400 batch_invalid');
    expect(code(() => readAgentBatch(Buffer.from('not gzip'), sum))).toBe('400 batch_invalid');
    expect(code(() => readAgentBatch({ seq: 0 }, sum))).toBe('400 batch_invalid');
    for (const bad of [{ seq: -1, rows: [] }, { seq: 1.5, rows: [] }, { seq: 0, rows: [1] }, { seq: 0, rows: {} }, [1], { seq: 0, lastKey: 5, rows: [] }]) {
      const p = pack(bad);
      expect(code(() => readAgentBatch(p.gz, p.sum))).toBe('400 batch_invalid');
    }
    const many = pack({ seq: 0, rows: Array.from({ length: 1001 }, () => ({})) });
    expect(code(() => readAgentBatch(many.gz, many.sum))).toBe('400 batch_invalid');
  });

  it('cannot inflate past its cap, however small the body (a gzip bomb)', () => {
    const json = Buffer.alloc(MAX_INFLATED_BYTES + 1024, 0x20);
    const gz = gzipSync(json);
    expect(gz.length).toBeLessThan(100_000);
    expect(code(() => readAgentBatch(gz, createHash('sha256').update(json).digest('hex')))).toBe('413 payload_too_large');
  });

  it('reads values as text the mapping understands', () => {
    expect(agentRowText({ a: 'x', b: 12, c: 1.25, d: true, e: false, f: null, g: '1.500' })).toEqual({ a: 'x', b: '12', c: '1.25', d: 'true', e: 'false', f: '', g: '1.500' });
    expect(agentCellText(undefined)).toBe('');
  });
});
