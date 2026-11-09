import { CsvAdapter } from '../providers/csv/csv.adapter';
import { RestApiAdapter } from '../providers/rest-api/rest-api.adapter';
import { ConnectorRegistry } from './connector.registry';
import { EntityImporterRegistry } from './entity-importer';
import { IMPORTED_TYPES, RecordImporter } from './record-importer';

/** The connectors and importers this deployment ships. Tests substitute their own registries (Nest `overrideProvider`). */
export const defaultConnectorRegistry = () => new ConnectorRegistry().register(new CsvAdapter()).register(new RestApiAdapter());
export const defaultImporterRegistry = () => IMPORTED_TYPES.reduce((reg, t) => reg.register(new RecordImporter(t)), new EntityImporterRegistry());
