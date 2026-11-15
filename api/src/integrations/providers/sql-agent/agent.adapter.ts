import { agentRowText } from '../../agents/agent-batch';
import { AdapterContext, ConnectionTestResult, ConnectorAdapter, ConnectorError, ConnectorMetadata, FetchResult } from '../../core/connector.interface';

/**
 * A database read through a connector agent (docs/connector-agent-plan.md AG3). Fortress never calls the database: the agent read the table
 * before the run was released and sent its rows in batches, which the run's lease hands this adapter, exactly as a file's chunks are handed to
 * the file importer. The cursor is the next batch number. Values arrive typed (AG-D7) and are read as the text the mapping already understands.
 * A connection test is a job for the agent (integrations.service), not a call from here; no credential is held by Fortress.
 */
/**
 * Where the next incremental read starts (AG4): the highest changed value the agent read, else the mark this run started from; nothing when the
 * source names no changed column. Kept as `{"w": …}`, the shape the REST connector uses; it reaches integration_sync_cursors only when the run finishes.
 */
export function agentMark(b: { changedColumn?: string; changedSince?: string; changedUpTo?: string }): string | null {
  if (!b.changedColumn) return null;
  const w = b.changedUpTo ?? b.changedSince;
  return w ? JSON.stringify({ w }) : null;
}

export class AgentAdapter implements ConnectorAdapter {
  getMetadata(): ConnectorMetadata {
    return { key: 'sql_agent', name: 'Database through a connector agent', kind: 'agent', authTypes: [], capabilities: { testable: true, incremental: true, webhooks: false, writeBack: false } };
  }

  async testConnection(_ctx: AdapterContext): Promise<ConnectionTestResult> {
    return { ok: false, message: 'The connector agent tests this connection: ask it from the connection\'s page.', notImplemented: true };
  }

  async fetchRecords(ctx: AdapterContext, _entity: string, cursor: string | null): Promise<FetchResult> {
    const batches = ctx.agentBatches;
    if (!batches) throw new ConnectorError('The connector agent has not sent this import\'s rows', 'malformed', false);
    // An incremental run starts from the saved mark (`{"w": …}`), not a batch number: the agent already used it, so reading starts at batch 0.
    const seq = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
    const rows = seq < batches.count ? await batches.read(seq) : null;
    if (seq < batches.count && !rows) throw new ConnectorError('The rows the agent sent have been cleared: run the import again', 'malformed', false);
    const next = seq + 1;
    const base = seq * 1000;
    const done = next >= batches.count;
    return {
      records: (rows ?? []).map((r, i) => ({ payload: agentRowText(r), sourceRow: base + i + 1 })),
      nextCursor: done ? agentMark(batches) : String(next),
      done,
    };
  }
}
