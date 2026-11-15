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
    expect(b).toEqual({ seq: 3, lastKey: 'M9', rows: [{ code: 'M9', qty: '1.500', due: '2026-01-02', active: true, notes: null }], checksum: sum, changedUpTo: null });
    const marked = pack({ seq: 0, lastKey: '1', rows: [], changedUpTo: '2026-11-05T08:00:00Z' });
    expect(readAgentBatch(marked.gz, marked.sum).changedUpTo).toBe('2026-11-05T08:00:00Z');
  });

  it('refuses rows that do not match the checksum, bad gzip and bad shapes', () => {
    const { gz, sum } = pack({ seq: 0, lastKey: null, rows: [] });
    expect(code(() => readAgentBatch(gz, 'a'.repeat(64)))).toBe('400 batch_checksum');
    expect(code(() => readAgentBatch(gz, undefined))).toBe('400 batch_invalid');
    expect(code(() => readAgentBatch(Buffer.from('not gzip'), sum))).toBe('400 batch_invalid');
    expect(code(() => readAgentBatch({ seq: 0 }, sum))).toBe('400 batch_invalid');
    for (const bad of [{ seq: 0, rows: [], changedUpTo: 5 }, { seq: -1, rows: [] }, { seq: 1.5, rows: [] }, { seq: 0, rows: [1] }, { seq: 0, rows: {} }, [1], { seq: 0, lastKey: 5, rows: [] }]) {
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

import { agentMark } from '../providers/sql-agent/agent.adapter';

describe('where the next incremental read of a database starts', () => {
  it('is the highest changed value read, else the mark the run started from, and nothing without a changed column', () => {
    expect(agentMark({ changedColumn: 'changed', changedSince: '2026-11-01', changedUpTo: '2026-11-05' })).toBe('{"w":"2026-11-05"}');
    expect(agentMark({ changedColumn: 'changed', changedSince: '2026-11-01' })).toBe('{"w":"2026-11-01"}');
    expect(agentMark({ changedColumn: 'changed' })).toBeNull();
    expect(agentMark({ changedUpTo: '2026-11-05' })).toBeNull();
  });
});

import { AgentAdapter } from '../providers/sql-agent/agent.adapter';

describe('an incremental run of a database', () => {
  it('starts at the first batch even though its cursor is the saved mark, and ends with the new mark', async () => {
    const agentBatches = { count: 1, read: async () => [{ id: 2 }], changedColumn: 'changed', changedSince: '2026-11-05', changedUpTo: '2026-11-09' };
    const page = await new AgentAdapter().fetchRecords({ config: {}, agentBatches } as never, 'machine', '{"w":"2026-11-05"}');
    expect(page).toMatchObject({ done: true, nextCursor: '{"w":"2026-11-09"}', records: [{ payload: { id: '2' }, sourceRow: 1 }] });
  });
});
