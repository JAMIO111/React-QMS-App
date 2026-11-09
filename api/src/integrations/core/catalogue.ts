import { NCR_SOURCE_LABELS, NCR_SOURCES } from '../../ncr/ncr.schemas';
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
const options = (values: readonly string[], label: (v: string) => string = words) => values.map((v) => ({ value: v, label: label(v) }));
const INTERVAL_UNITS = ['days', 'weeks', 'months', 'years'];

/** A link to another Fortress record, given in the file by its code (matched ignoring case when the record is imported). */
const ref = (key: string, label: string, what: string, extra: Partial<CatalogueField> = {}): CatalogueField => ({
  key,
  label,
  type: 'text',
  maxLength: 100,
  description: `The ${what} as it is in Fortress; it must already exist`,
  ...extra,
});

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
  {
    entityType: 'machine',
    label: 'Machines',
    keyHint: 'The machine or asset code',
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true, maxLength: 40, description: 'Unique in Fortress' },
      { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 120 },
      ref('site', 'Site', 'site code'),
      { key: 'workCentre', label: 'Work centre', type: 'text', maxLength: 100 },
      { key: 'description', label: 'Description', type: 'text', maxLength: 1000 },
      { key: 'active', label: 'Active', type: 'boolean', description: 'Yes / no; empty keeps it active' },
    ],
  },
  {
    entityType: 'employee',
    label: 'Employees',
    keyHint: 'The employee or payroll number',
    fields: [
      { key: 'employeeNumber', label: 'Employee number', type: 'text', required: true, maxLength: 40, description: 'Unique in Fortress' },
      { key: 'firstName', label: 'First name', type: 'text', required: true, maxLength: 100 },
      { key: 'surname', label: 'Surname', type: 'text', required: true, maxLength: 100 },
      { key: 'jobTitle', label: 'Job title', type: 'text', maxLength: 100 },
      { key: 'email', label: 'Email', type: 'email', maxLength: 200 },
      ref('site', 'Site', 'site code'),
      ref('department', 'Department', 'department code', { description: 'The department code as it is in Fortress; it must already exist, and fills the site when that is empty' }),
      { key: 'active', label: 'Active', type: 'boolean', description: 'Yes / no; empty keeps them active. Linking an employee to a sign-in stays a person\'s step' },
    ],
  },
  {
    entityType: 'gauge_type',
    label: 'Gauge types',
    keyHint: 'The gauge type name, or its code in your system',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 100, description: 'Unique in Fortress' },
      { key: 'description', label: 'Description', type: 'text', maxLength: 1000 },
      { key: 'intervalValue', label: 'Calibration interval', type: 'integer', description: 'A whole number from 1 to 1000; empty means 12' },
      { key: 'intervalUnit', label: 'Interval unit', type: 'enum', options: options(INTERVAL_UNITS), description: 'Empty means months' },
      { key: 'active', label: 'Active', type: 'boolean', description: 'Yes / no; empty keeps it active. Characteristics are set up in Fortress' },
    ],
  },
  {
    entityType: 'gauge',
    label: 'Gauges',
    keyHint: 'The gauge asset number',
    fields: [
      { key: 'assetNumber', label: 'Asset number', type: 'text', required: true, maxLength: 40, description: 'Unique in Fortress' },
      { key: 'description', label: 'Description', type: 'text', required: true, maxLength: 200 },
      ref('gaugeType', 'Gauge type', 'gauge type name', { description: 'The gauge type name as it is in Fortress; it must already exist, and gives the gauge its characteristics' }),
      { key: 'manufacturer', label: 'Manufacturer', type: 'text', maxLength: 100 },
      { key: 'model', label: 'Model', type: 'text', maxLength: 100 },
      { key: 'serialNumber', label: 'Serial number', type: 'text', maxLength: 100 },
      ref('site', 'Site', 'site code'),
      ref('department', 'Department', 'department code'),
      { key: 'location', label: 'Location', type: 'text', maxLength: 200 },
      { key: 'rangeMin', label: 'Range from', type: 'number' },
      { key: 'rangeMax', label: 'Range to', type: 'number' },
      ref('unit', 'Unit', 'unit code', { maxLength: 20, description: 'A unit code Fortress knows, such as mm' }),
      { key: 'resolution', label: 'Resolution', type: 'number', description: 'Greater than 0' },
      { key: 'calibrationSource', label: 'Calibrated', type: 'enum', options: options(['internal', 'external']), description: 'Internal or external; empty means internal' },
      ref('supplier', 'Calibration supplier', 'supplier code'),
      { key: 'intervalValue', label: 'Calibration interval', type: 'integer', description: 'Empty follows the gauge type' },
      { key: 'intervalUnit', label: 'Interval unit', type: 'enum', options: options(INTERVAL_UNITS) },
      { key: 'commissionedOn', label: 'Commissioned on', type: 'date' },
      { key: 'notes', label: 'Notes', type: 'text', maxLength: 5000, description: 'Calibration dates and status come from calibrations recorded in Fortress, not from the file' },
    ],
  },
  {
    entityType: 'nonconformance',
    label: 'Non-conformances',
    keyHint: 'The non-conformance number in your old system',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, maxLength: 200 },
      { key: 'source', label: 'Source', type: 'enum', required: true, options: options(NCR_SOURCES, (v) => NCR_SOURCE_LABELS[v as (typeof NCR_SOURCES)[number]]), description: 'Where it came from or was found' },
      ref('category', 'Category', 'category code', { description: 'A category code such as PRODUCT or PROCESS; it must already exist' }),
      { key: 'severity', label: 'Severity', type: 'enum', options: options(['critical', 'major', 'minor']) },
      { key: 'description', label: 'Description', type: 'text', maxLength: 5000 },
      { key: 'requirement', label: 'Requirement', type: 'text', maxLength: 2000 },
      { key: 'actualResult', label: 'Actual result', type: 'text', maxLength: 2000 },
      { key: 'detectedAt', label: 'Detected on', type: 'date' },
      ref('site', 'Site', 'site code'),
      ref('part', 'Part number', 'part number'),
      ref('customer', 'Customer', 'customer code', { description: 'Needed when the source is Customer' }),
      ref('supplier', 'Supplier', 'supplier code', { description: 'Needed when the source is Supplier' }),
      ref('detectionMachine', 'Where detected', 'machine code'),
      ref('causalMachine', 'Causal process', 'machine code'),
      ref('responsibleEmployee', 'Responsible employee', 'employee number'),
      { key: 'quantityAffected', label: 'Quantity affected', type: 'number' },
      { key: 'quantityInspected', label: 'Quantity inspected', type: 'number' },
      { key: 'workOrder', label: 'Work order', type: 'text', maxLength: 60 },
      { key: 'purchaseOrder', label: 'Purchase order', type: 'text', maxLength: 60 },
      { key: 'customerReference', label: 'Customer reference', type: 'text', maxLength: 60 },
      { key: 'lotNumber', label: 'Lot number', type: 'text', maxLength: 60 },
      { key: 'serialNumber', label: 'Serial number', type: 'text', maxLength: 60, description: 'Imported non-conformances arrive as drafts with a Fortress reference; opening, moving and closing them stay a person\'s steps' },
    ],
  },
];

export const catalogueFor = (entity: string): EntityCatalogue | undefined => CATALOGUE.find((c) => c.entityType === entity);
