import { EntityType } from './entity-importer';

/**
 * The canonical fields each kind of record takes from a source (brief §6: a canonical data model, never a free-form store). A mapping can only point source
 * columns at these targets, and every value is checked against its type here before it is staged. The importers (IN4–IN6) write exactly these fields.
 * Only kinds with a catalogue can be previewed; one is importable once its importer exists.
 */
export type FieldType = 'text' | 'email' | 'url' | 'country' | 'number' | 'integer' | 'date' | 'boolean' | 'enum';

export interface CatalogueField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  maxLength?: number;
  options?: { value: string; label: string }[];
  description?: string;
}

export interface EntityCatalogue {
  entityType: EntityType;
  label: string;
  /** What the key column usually is, to help a person choose it. */
  keyHint: string;
  fields: CatalogueField[];
}

const SUPPLIER_TYPES = ['manufacturer', 'distributor', 'subcontractor', 'service_provider', 'calibration_provider', 'logistics_provider', 'other'];
const words = (v: string) => v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const party = (extra: CatalogueField[] = []): CatalogueField[] => [
  { key: 'code', label: 'Code', type: 'text', required: true, maxLength: 40, description: 'Your short code for them; unique in Fortress' },
  { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 200 },
  { key: 'displayName', label: 'Display name', type: 'text', maxLength: 200 },
  { key: 'companyNumber', label: 'Company number', type: 'text', maxLength: 50 },
  { key: 'vatNumber', label: 'VAT number', type: 'text', maxLength: 50 },
  ...extra,
  { key: 'notes', label: 'Notes', type: 'text', maxLength: 2000 },
  { key: 'active', label: 'Active', type: 'boolean', description: 'Yes / no; empty keeps it active' },
];

export const CATALOGUE: EntityCatalogue[] = [
  {
    entityType: 'supplier',
    label: 'Suppliers',
    keyHint: 'The supplier account number in your system',
    fields: party([
      { key: 'supplierType', label: 'Supplier type', type: 'enum', options: SUPPLIER_TYPES.map((v) => ({ value: v, label: words(v) })) },
      { key: 'email', label: 'Email', type: 'email', maxLength: 200 },
      { key: 'phone', label: 'Phone', type: 'text', maxLength: 50 },
      { key: 'website', label: 'Website', type: 'url', maxLength: 300 },
      { key: 'addressLine1', label: 'Address line 1', type: 'text', maxLength: 200 },
      { key: 'addressLine2', label: 'Address line 2', type: 'text', maxLength: 200 },
      { key: 'city', label: 'Town or city', type: 'text', maxLength: 100 },
      { key: 'region', label: 'County or region', type: 'text', maxLength: 100 },
      { key: 'postcode', label: 'Postcode', type: 'text', maxLength: 20 },
      { key: 'country', label: 'Country', type: 'country', description: 'Two-letter code, such as GB' },
      { key: 'purchasingReference', label: 'Purchasing reference', type: 'text', maxLength: 100 },
    ]),
  },
  {
    entityType: 'customer',
    label: 'Customers',
    keyHint: 'The customer account number in your system',
    fields: party(),
  },
  {
    entityType: 'part',
    label: 'Parts',
    keyHint: 'The part number',
    fields: [
      { key: 'partNumber', label: 'Part number', type: 'text', required: true, maxLength: 100 },
      { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 200 },
      { key: 'description', label: 'Description', type: 'text', maxLength: 2000 },
      { key: 'revision', label: 'Revision', type: 'text', maxLength: 20, description: 'Arrives as a draft revision; releasing it stays a person\'s decision' },
      { key: 'active', label: 'Active', type: 'boolean', description: 'Yes / no; empty keeps it active' },
    ],
  },
];

export const catalogueFor = (entity: string): EntityCatalogue | undefined => CATALOGUE.find((c) => c.entityType === entity);
