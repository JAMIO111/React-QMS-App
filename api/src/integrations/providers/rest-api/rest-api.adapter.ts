import { AdapterContext, ConnectionTestResult, ConnectorAdapter, ConnectorMetadata } from '../../core/connector.interface';

/**
 * Generic REST connector. IN1 registers it so connections can be created and their credentials stored; it makes **no outbound request yet**.
 * The connector itself (pagination, cursors, rate limits) and its SSRF defences (private and metadata addresses, redirects, DNS rebinding, timeouts, size caps) arrive together in IN7:
 * a network call is not made from this code until those protections exist.
 */
export class RestApiAdapter implements ConnectorAdapter {
  getMetadata(): ConnectorMetadata {
    return { key: 'rest_api', name: 'REST API', kind: 'api', authTypes: ['api_key', 'bearer', 'basic'], capabilities: { testable: true, incremental: true, webhooks: false, writeBack: false } };
  }

  async testConnection(_ctx: AdapterContext): Promise<ConnectionTestResult> {
    return { ok: false, notImplemented: true, message: 'Testing a REST connection is not available yet: it arrives with the REST connector.' };
  }
}
