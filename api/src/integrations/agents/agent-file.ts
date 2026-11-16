import { createHash } from 'node:crypto';
import { ApiError } from '../../common/api-error';
import { ParsedFile, ParseOptions } from '../core/file-parsers';

/**
 * A file from a folder, sent by the connector agent in parts (AG5b). The agent never parses: Fortress puts the parts back together, checks them
 * against what the agent says it sent, and reads them with the same reader as uploaded files.
 */
export const MAX_PART_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 26_214_400;
export const BATCH_ROWS = 1000;

/** One part as it arrives: the raw body, `X-Part-Seq` and `X-Part-Checksum` (SHA-256 of the body, hex), checked here before the database sees it. */
export function readFilePart(body: unknown, seqHeader: string | undefined, checksumHeader: string | undefined): { seq: number; checksum: string; data: Buffer } {
  if (!Buffer.isBuffer(body) || body.length === 0) throw ApiError.badRequest('file_part_invalid', 'A part of a file is its raw bytes (Content-Type: application/octet-stream)');
  if (body.length > MAX_PART_BYTES) throw new ApiError(413, 'payload_too_large', 'A part of a file is at most 1 MB');
  const seq = Number(seqHeader);
  if (!/^\d{1,2}$/.test(seqHeader ?? '') || seq > 63) throw ApiError.badRequest('file_part_invalid', 'A part needs its place in the file (X-Part-Seq: 0 to 63)');
  const checksum = (checksumHeader ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(checksum)) throw ApiError.badRequest('file_part_invalid', 'A part needs its checksum (X-Part-Checksum: SHA-256 in hex)');
  if (createHash('sha256').update(body).digest('hex') !== checksum) throw ApiError.badRequest('file_part_checksum', 'The part does not match its checksum: send it again');
  return { seq, checksum, data: body };
}

export interface SentFileInfo {
  name: string;
  size: number;
  sha256: string;
  modifiedAt?: string;
}

/** What the agent says it sent, from its result (`file` and `parts`); null when the result names no file (an unchanged file, or no folder job). */
export function sentFile(result: unknown): { file: SentFileInfo; parts: number } | null {
  const r = result as { file?: Partial<SentFileInfo>; parts?: unknown } | null;
  if (!r || typeof r !== 'object' || !r.file || typeof r.parts !== 'number' || r.parts < 1) return null;
  const f = r.file;
  if (typeof f.name !== 'string' || !f.name || f.name.length > 255 || typeof f.size !== 'number' || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(f.sha256)) {
    throw ApiError.badRequest('file_invalid', 'The agent did not say which file it sent (name, size and SHA-256)');
  }
  return { file: { name: f.name, size: f.size, sha256: f.sha256.toLowerCase(), modifiedAt: typeof f.modifiedAt === 'string' ? f.modifiedAt : undefined }, parts: r.parts };
}

/** The parts back in one file, refused unless they are every part, the size and the SHA-256 the agent reported. */
export function assembleFile(parts: Array<{ seq: number; data: Buffer }>, expected: { file: SentFileInfo; parts: number }): Buffer {
  if (parts.length !== expected.parts || parts.some((p, i) => p.seq !== i)) {
    throw new ApiError(409, 'agent_file_incomplete', `The agent says it sent ${expected.parts} parts of ${expected.file.name}, but Fortress holds ${parts.length}: send the file again`);
  }
  const bytes = Buffer.concat(parts.map((p) => p.data));
  if (bytes.length !== expected.file.size || bytes.length > MAX_FILE_BYTES) {
    throw new ApiError(409, 'agent_file_incomplete', `${expected.file.name} arrived with ${bytes.length} bytes, not ${expected.file.size}: send it again`);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== expected.file.sha256) {
    throw new ApiError(409, 'agent_file_incomplete', `${expected.file.name} did not arrive as it was sent: send it again`);
  }
  return bytes;
}

/** How to read a folder's files: the connection's settings, as for uploaded files (worked out from the file when not set). */
export function folderParseOptions(connection: Record<string, unknown> | undefined): ParseOptions {
  const c = connection ?? {};
  return {
    delimiter: (c.delimiter as ParseOptions['delimiter']) ?? 'auto',
    encoding: (c.encoding as ParseOptions['encoding']) ?? 'auto',
    hasHeader: c.hasHeader !== false,
  };
}

/** A preview's result: the file, its columns and its first rows (values as text). */
export function previewResult(parsed: ParsedFile, file: SentFileInfo, limit: number) {
  const n = Math.min(Math.max(limit, 1), 50);
  return {
    file,
    columns: parsed.headers.map((name) => ({ name })),
    rows: parsed.rows.slice(0, n).map((r) => cut(r.values)),
    truncated: parsed.rows.length > n,
    rowCount: parsed.rows.length,
    sheet: parsed.sheet,
  };
}

/** An extraction's batches: rows of 1,000 in file order, each with its checksum and the last row's number as its last key. */
export function fileBatches(parsed: ParsedFile, maxRows?: number) {
  const rows = maxRows ? parsed.rows.slice(0, maxRows) : parsed.rows;
  const batches: Array<{ seq: number; rows: Array<Record<string, string>>; lastKey: string; checksum: string }> = [];
  for (let seq = 0; seq * BATCH_ROWS < rows.length; seq += 1) {
    const slice = rows.slice(seq * BATCH_ROWS, (seq + 1) * BATCH_ROWS);
    const values = slice.map((r) => r.values);
    batches.push({ seq, rows: values, lastKey: String(slice[slice.length - 1].row), checksum: createHash('sha256').update(JSON.stringify(values)).digest('hex') });
  }
  return { batches, rows: rows.length, truncated: rows.length < parsed.rows.length };
}

const cut = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.length > 1000 ? `${v.slice(0, 1000)}…` : v]));
