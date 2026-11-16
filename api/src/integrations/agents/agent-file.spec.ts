import { createHash } from 'node:crypto';
import { ApiError } from '../../common/api-error';
import { parseFile } from '../core/file-parsers';
import { assembleFile, fileBatches, folderParseOptions, previewResult, readFilePart, sentFile } from './agent-file';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const code = (f: () => unknown) => {
  try {
    f();
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.getStatus()} ${(e as { code?: string }).code}` : String(e);
  }
};

describe('a file sent by the connector agent in parts (AG5b)', () => {
  it('takes a part only with its place and the checksum of its bytes', () => {
    const bytes = Buffer.from('code;name\nM1;Press\n');
    expect(readFilePart(bytes, '0', sha(bytes).toUpperCase())).toMatchObject({ seq: 0, checksum: sha(bytes) });
    expect(code(() => readFilePart(bytes, '0', 'a'.repeat(64)))).toBe('400 file_part_checksum');
    expect(code(() => readFilePart(bytes, undefined, sha(bytes)))).toBe('400 file_part_invalid');
    expect(code(() => readFilePart(bytes, '64', sha(bytes)))).toBe('400 file_part_invalid');
    expect(code(() => readFilePart(bytes, '-1', sha(bytes)))).toBe('400 file_part_invalid');
    expect(code(() => readFilePart({ seq: 0 }, '0', sha(bytes)))).toBe('400 file_part_invalid');
    const big = Buffer.alloc(1024 * 1024 + 1);
    expect(code(() => readFilePart(big, '0', sha(big)))).toBe('413 payload_too_large');
  });

  it('puts the parts back together only when they are every part, the size and the hash the agent reported', () => {
    const whole = Buffer.from('code\nM1\nM2\n');
    const parts = [{ seq: 0, data: whole.subarray(0, 5) }, { seq: 1, data: whole.subarray(5) }];
    const expected = { file: { name: 'machines.csv', size: whole.length, sha256: sha(whole) }, parts: 2 };
    expect(assembleFile(parts, expected).equals(whole)).toBe(true);
    expect(code(() => assembleFile(parts.slice(0, 1), expected))).toBe('409 agent_file_incomplete');
    expect(code(() => assembleFile([parts[1], parts[0]], expected))).toBe('409 agent_file_incomplete');
    expect(code(() => assembleFile(parts, { ...expected, file: { ...expected.file, size: 3 } }))).toBe('409 agent_file_incomplete');
    expect(code(() => assembleFile(parts, { ...expected, file: { ...expected.file, sha256: 'b'.repeat(64) } }))).toBe('409 agent_file_incomplete');
  });

  it('reads what the agent says it sent, and nothing when it sent no file', () => {
    expect(sentFile({ file: { name: 'm.csv', size: 3, sha256: 'A'.repeat(64) }, parts: 1 })).toEqual({ file: { name: 'm.csv', size: 3, sha256: 'a'.repeat(64) }, parts: 1 });
    expect(sentFile({ file: { name: 'm.csv', size: 3, sha256: 'a'.repeat(64) }, parts: 0, unchanged: true })).toBeNull();
    expect(sentFile({ columns: [], rows: [] })).toBeNull();
    expect(sentFile(null)).toBeNull();
    expect(code(() => sentFile({ file: { name: 'm.csv', size: 3, sha256: 'nope' }, parts: 1 }))).toBe('400 file_invalid');
  });

  it('reads the file with the folder connection\'s settings and turns it into a preview or batches', () => {
    expect(folderParseOptions({ delimiter: ';', hasHeader: false })).toEqual({ delimiter: ';', encoding: 'auto', hasHeader: false });
    expect(folderParseOptions(undefined)).toEqual({ delimiter: 'auto', encoding: 'auto', hasHeader: true });
    const text = 'code;name\n' + Array.from({ length: 2500 }, (_, i) => `M${i + 1};Machine ${i + 1}`).join('\n') + '\n';
    const parsed = parseFile('machines.csv', Buffer.from(text), folderParseOptions({ delimiter: ';' }));
    const file = { name: 'machines.csv', size: text.length, sha256: 'c'.repeat(64) };
    const preview = previewResult(parsed, file, 3);
    expect(preview.columns).toEqual([{ name: 'code' }, { name: 'name' }]);
    expect(preview.rows).toEqual([{ code: 'M1', name: 'Machine 1' }, { code: 'M2', name: 'Machine 2' }, { code: 'M3', name: 'Machine 3' }]);
    expect(preview).toMatchObject({ truncated: true, rowCount: 2500, file });
    const { batches, rows, truncated } = fileBatches(parsed);
    expect(batches.map((b) => b.rows.length)).toEqual([1000, 1000, 500]);
    expect(batches.map((b) => b.seq)).toEqual([0, 1, 2]);
    expect(rows).toBe(2500);
    expect(truncated).toBe(false);
    expect(batches[0].checksum).toBe(createHash('sha256').update(JSON.stringify(batches[0].rows)).digest('hex'));
    expect(batches[2].rows[499]).toEqual({ code: 'M2500', name: 'Machine 2500' });
    // a preview run reads at most what its extraction may hold
    expect(fileBatches(parsed, 1000)).toMatchObject({ rows: 1000, truncated: true });
  });
});
