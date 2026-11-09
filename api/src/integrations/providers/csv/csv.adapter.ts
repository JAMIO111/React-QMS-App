import { AdapterContext, ConnectionTestResult, ConnectorAdapter, ConnectorError, ConnectorMetadata, FetchResult } from '../../core/connector.interface';

/**
 * File importer: nothing is fetched from a customer system. A person uploads a CSV or Excel file, the API parses it into chunks of rows (files service), and an
 * import reads those chunks one page at a time. The cursor is the next chunk number.
 */
export class CsvAdapter implements ConnectorAdapter {
  getMetadata(): ConnectorMetadata {
    return { key: 'csv', name: 'CSV / Excel file', kind: 'file', authTypes: [], capabilities: { testable: false, incremental: false, webhooks: false, writeBack: false } };
  }

  async testConnection(_ctx: AdapterContext): Promise<ConnectionTestResult> {
    return { ok: true, message: 'A file importer has no connection to test: you upload the file when you import.' };
  }

  async fetchRecords(ctx: AdapterContext, _entity: string, cursor: string | null): Promise<FetchResult> {
    if (!ctx.file) throw new ConnectorError('This import has no file', 'malformed', false);
    const seq = cursor ? Number(cursor) : 0;
    const rows = seq < ctx.file.chunkCount ? await ctx.file.readChunk(seq) : null;
    if (seq < ctx.file.chunkCount && !rows) throw new ConnectorError('The file\'s rows have been cleared (kept for 90 days): upload it again', 'malformed', false);
    const next = seq + 1;
    return { records: (rows ?? []).map((r) => ({ payload: r.v, sourceRow: r.r })), nextCursor: String(next), done: next >= ctx.file.chunkCount };
  }
}
