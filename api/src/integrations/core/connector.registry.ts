import { ConnectorAdapter } from './connector.interface';

/** The adapters this deployment knows, by provider key. Adding a provider means registering an adapter here and a row in `integration_providers`. */
export class ConnectorRegistry {
  private readonly adapters = new Map<string, ConnectorAdapter>();

  register(adapter: ConnectorAdapter): this {
    const key = adapter.getMetadata().key;
    if (this.adapters.has(key)) throw new Error(`Connector ${key} is registered twice`);
    this.adapters.set(key, adapter);
    return this;
  }

  get(key: string): ConnectorAdapter | undefined {
    return this.adapters.get(key);
  }

  all(): ConnectorAdapter[] {
    return [...this.adapters.values()];
  }
}
