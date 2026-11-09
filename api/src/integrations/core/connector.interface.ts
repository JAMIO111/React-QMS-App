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

export interface FetchResult {
  records: Array<Record<string, unknown>>;
  nextCursor: string | null;
  done: boolean;
}

export interface ConnectorAdapter {
  getMetadata(): ConnectorMetadata;
  testConnection(ctx: AdapterContext): Promise<ConnectionTestResult>;
  discoverEntities?(ctx: AdapterContext): Promise<ExternalEntity[]>;
  fetchRecords?(ctx: AdapterContext, entity: string, cursor?: string): Promise<FetchResult>;
  /** Declared for completeness (brief §7.3); webhooks and write-back are Phase 6 and no adapter implements them. */
  subscribeToEvents?(ctx: AdapterContext): Promise<void>;
  pushRecord?(ctx: AdapterContext, entity: string, record: unknown): Promise<unknown>;
}
