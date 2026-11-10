/**
 * The contract every provider adapter implements (brief §7.3). Adapters only know how to talk to a source; they never write QMS records.
 * Not every provider supports everything, so the contract is a set of optional capabilities discovered from `getMetadata()`.
 * IN1 needs `getMetadata` and `testConnection`; fetching and discovery arrive with the file importer (IN3) and the REST connector (IN7).
 */
export type ProviderKind = 'file' | 'api' | 'agent';

export interface ConnectorMetadata {
  key: string;
  name: string;
  kind: ProviderKind;
  /** The credential kinds the provider can use (empty: it needs none). */
  authTypes: string[];
  capabilities: { testable: boolean; incremental: boolean; webhooks: boolean; writeBack: boolean };
}

/** What an adapter is given: the connection's non-secret configuration and, when it needs one, the decrypted credential. The secret is never stored or logged by the adapter. */
export interface AdapterContext {
  config: Record<string, unknown>;
  secret: string | null;
  /** The organisation's allow-list of host names for outbound connections (empty or absent: any public host). */
  allowedHosts?: string[];
  /** For a file connection: the uploaded file the run imports, read a chunk at a time (null past the end). */
  file?: { id: string; chunkCount: number; readChunk(seq: number): Promise<Array<{ r: number; v: Record<string, string> }> | null> };
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  /** The adapter cannot test yet (the feature is not built): the result is reported but not recorded as a failed test. */
  notImplemented?: boolean;
}

export interface ExternalEntity {
  key: string;
  label: string;
}

/** One record as the source gave it, with its row number in a file when there is one. */
export interface FetchedRecord {
  payload: Record<string, unknown>;
  sourceRow?: number;
}

/** One page of records. `nextCursor` is where the next page (or the next incremental run) starts; `done` is true on the last page. */
export interface FetchResult {
  records: FetchedRecord[];
  nextCursor: string | null;
  done: boolean;
}

export type RunErrorKind = 'auth' | 'rate_limit' | 'malformed' | 'mapping' | 'transient' | 'timeout' | 'limit' | 'internal';

/**
 * What an adapter throws when the source cannot be read. `transient` errors are tried again later (up to five attempts, waiting longer each time, or as long
 * as the source's Retry-After says); the others fail the run with the message, which must make sense to a person and never contain a secret.
 */
export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly kind: RunErrorKind,
    readonly transient: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export interface ConnectorAdapter {
  getMetadata(): ConnectorMetadata;
  testConnection(ctx: AdapterContext): Promise<ConnectionTestResult>;
  discoverEntities?(ctx: AdapterContext): Promise<ExternalEntity[]>;
  fetchRecords?(ctx: AdapterContext, entity: string, cursor: string | null): Promise<FetchResult>;
  /** Declared for completeness (brief §7.3); webhooks and write-back are Phase 6 and no adapter implements them. */
  subscribeToEvents?(ctx: AdapterContext): Promise<void>;
  pushRecord?(ctx: AdapterContext, entity: string, record: unknown): Promise<unknown>;
}
