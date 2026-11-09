import { AdapterContext, ConnectionTestResult, ConnectorAdapter, ConnectorMetadata } from '../../core/connector.interface';

/** File importer: nothing is fetched from a customer system, so there is no connection to test. Parsing and discovery arrive with IN3. */
export class CsvAdapter implements ConnectorAdapter {
  getMetadata(): ConnectorMetadata {
    return { key: 'csv', name: 'CSV / Excel file', kind: 'file', authTypes: [], capabilities: { testable: false, incremental: false, webhooks: false, writeBack: false } };
  }

  async testConnection(_ctx: AdapterContext): Promise<ConnectionTestResult> {
    return { ok: true, message: 'A file importer has no connection to test: you upload the file when you import.' };
  }
}
