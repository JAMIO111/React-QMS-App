import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { ApiError } from '../../common/api-error';

/** A batch of extracted rows inflates to at most this much (docs/connector-agent-plan.md AG-D6: the 1 MB body limit applies before inflating). */
export const MAX_INFLATED_BYTES = 8 * 1024 * 1024;
export const MAX_BATCH_ROWS = 1000;

export interface AgentBatch {
  seq: number;
  lastKey: string | null;
  rows: Array<Record<string, unknown>>;
  checksum: string;
}

/**
 * Read one batch the agent sent (AG3): the body is gzip of `{"seq", "lastKey", "rows"}` and the header carries the SHA-256 (hex) of the JSON
 * inside. It is inflated here, with a cap, so a small body cannot expand without limit; then the checksum, the shape and the size are checked.
 */
export function readAgentBatch(body: unknown, checksumHeader: string | undefined): AgentBatch {
  if (!Buffer.isBuffer(body) || body.length === 0) throw ApiError.badRequest('batch_invalid', 'A batch is a gzip body (Content-Type: application/gzip)');
  const checksum = (checksumHeader ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(checksum)) throw ApiError.badRequest('batch_invalid', 'A batch needs its checksum (X-Batch-Checksum: SHA-256 in hex)');
  let json: Buffer;
  try {
    json = gunzipSync(body, { maxOutputLength: MAX_INFLATED_BYTES });
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) {
      throw new ApiError(413, 'payload_too_large', `A batch may hold at most ${MAX_INFLATED_BYTES / 1024 / 1024} MB of rows once inflated: send smaller batches`);
    }
    throw ApiError.badRequest('batch_invalid', 'The batch is not valid gzip');
  }
  if (createHash('sha256').update(json).digest('hex') !== checksum) {
    throw ApiError.badRequest('batch_checksum', 'The batch\'s rows do not match its checksum: send it again');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.toString('utf8'));
  } catch {
    throw ApiError.badRequest('batch_invalid', 'The batch is not valid JSON');
  }
  const b = parsed as { seq?: unknown; lastKey?: unknown; rows?: unknown };
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw ApiError.badRequest('batch_invalid', 'A batch is an object with seq, lastKey and rows');
  if (typeof b.seq !== 'number' || !Number.isInteger(b.seq) || b.seq < 0 || b.seq > 100_000) throw ApiError.badRequest('batch_invalid', 'A batch needs its sequence number');
  if (b.lastKey !== null && b.lastKey !== undefined && (typeof b.lastKey !== 'string' || b.lastKey.length > 2000)) {
    throw ApiError.badRequest('batch_invalid', 'The last key is text of at most 2,000 characters');
  }
  if (!Array.isArray(b.rows) || b.rows.length > MAX_BATCH_ROWS) throw ApiError.badRequest('batch_invalid', `A batch holds a list of at most ${MAX_BATCH_ROWS} rows`);
  for (const row of b.rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw ApiError.badRequest('batch_invalid', 'Each row is an object of column values');
  }
  return { seq: b.seq, lastKey: (b.lastKey as string | null | undefined) ?? null, rows: b.rows as Array<Record<string, unknown>>, checksum };
}

/**
 * A database value as the import mapping reads it (AG-D7): text as it is, numbers as written (the agent sends decimals as text already, so no
 * digit is lost), true / false, empty for null. Dates arrive as ISO text.
 */
export function agentCellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

export const agentRowText = (row: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, agentCellText(v)]));
