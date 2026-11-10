import { NCR_SOURCE_LABELS, NCR_SOURCES } from '../../ncr/ncr.schemas';
import { EntityType } from './entity-importer';

/**
 * The canonical fields each kind of record takes from a source (brief §6: a canonical data model, never a free-form store). A mapping can only point source
 * columns at these targets, and every value is checked against its type here before it is staged. The importers (IN4–IN6) write exactly these fields.
 * Only kinds with a catalogue can be previewed; one is importable once its importer exists.
 * Which fields are offered, their labels and whether they are required are written here. At runtime the length limits, patterns, allowed values and
 * numeric bounds are read from the database's own rules (core/column-rules.ts, CatalogueService); the limits written here are only the fallback.
 * core/columns.ts says which column each field fills, and test/integration-catalogue-drift.e2e-spec.ts fails when the schema and these drift apart.
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
  /** From the database's own CHECK constraints (core/column-rules.ts): a pattern the text must match, and numeric bounds. */
  pattern?: string;
  min?: number;
  max?: number;
  minExclusive?: boolean;
  /** A link to another record (D10): given in the file by its Fortress code, or (when `source`) by the id the source gave it in an earlier import. */
  ref?: { kind: RefKind; source: boolean };
  /** One of the organisation's custom fields (key `cf_<field key>`), written to its custom values, not a column. */
  custom?: boolean;
  /** A field whose new value cannot be held for review (IN5): it only ever adds (a part's revision). Custom fields cannot be reviewed either. */
  noReview?: boolean;
}

/** What a reference can point at. The importable kinds can also be matched by the source's own id (the map of an earlier import). */
export type RefKind = 'site' | 'department' | 'unit' | 'category' | 'supplier' | 'customer' | 'part' | 'machine' | 'employee' | 'gauge_type';
export const REF_KIND_WORDS: Record<RefKind, string> = {
  site: 'site',
  department: 'department',
  unit: 'unit',
  category: 'category',
  supplier: 'supplier',
  customer: 'customer',
  part: 'part',
  machine: 'machine',
  employee: 'employee',
  gauge_type: 'gauge type',
};
const SOURCE_KINDS: RefKind[] = ['supplier', 'customer', 'part', 'machine', 'employee', 'gauge_type'];

export interface EntityCatalogue {
  entityType: EntityType;
  label: string;
  /** What the key column usually is, to help a person choose it. */
  keyHint: string;
  /** A field added to the key column's value to identify a record (E4: an order line is "order number/line number"). */
  keySuffix?: string;
  fields: CatalogueField[];
}

const SUPPLIER_TYPES = ['manufacturer', 'distributor', 'subcontractor', 'service_provider', 'calibration_provider', 'logistics_provider', 'other'];
const words = (v: string) => v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const options = (values: readonly string[], label: (v: string) => string = words) => values.map((v) => ({ value: v, label: label(v) }));
const INTERVAL_UNITS = ['days', 'weeks', 'months', 'years'];
const PRODUCTION_STATUSES = ['planned', 'released', 'in_progress', 'completed', 'closed', 'cancelled'];

/** A link to another Fortress record, given in the file by its code (matched ignoring case when the record is imported). */
const ref = (key: string, label: string, kind: RefKind, what: string, extra: Partial<CatalogueField> = {}): CatalogueField => ({
  key,
  label,
  type: 'text',
  maxLength: 100,
  description: SOURCE_KINDS.includes(kind)
    ? `The ${what} in Fortress, or the id your source gave it when it was imported here; it must already exist`
    : `The ${what} as it is in Fortress; it must already exist`,
  ...extra,
  ref: { kind, source: SOURCE_KINDS.includes(kind) },
});

const party = (extra: CatalogueField[] = []): CatalogueField[] => [
  { key: 'code', label: 'Code', type: 'text', required: true, maxLength: 20, description: 'Your short code for them in capitals (letters, digits, - and _); unique in Fortress' },
  { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 200 },
  { key: 'displayName', label: 'Display name', type: 'text', maxLength: 100 },
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
      { key: 'phone', label: 'Phone', type: 'text', maxLength: 40 },
      { key: 'website', label: 'Website', type: 'url', maxLength: 300 },
      { key: 'addressLine1', label: 'Address line 1', type: 'text', maxLength: 120 },
      { key: 'addressLine2', label: 'Address line 2', type: 'text', maxLength: 120 },
      { key: 'city', label: 'Town or city', type: 'text', maxLength: 80 },
      { key: 'region', label: 'County or region', type: 'text', maxLength: 80 },
      { key: 'postcode', label: 'Postcode', type: 'text', maxLength: 20 },
      { key: 'country', label: 'Country', type: 'country', description: 'Two-letter code, such as GB' },
      { key: 'purchasingReference', label: 'Purchasing reference', type: 'text', maxLength: 60 },
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
      { key: 'partNumber', label: 'Part number', type: 'text', required: true, maxLength: 60 },
      { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 200 },
      { key: 'description', label: 'Description', type: 'text', maxLength: 2000 },
      { key: 'revision', label: 'Revision', type: 'text', maxLength: 20, noReview: true, description: 'Arrives as a draft revision; releasing it stays a person\'s decision' },
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
      ref('site', 'Site', 'site', 'site code'),
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
      ref('site', 'Site', 'site', 'site code'),
      ref('department', 'Department', 'department', 'department code', { description: 'The department code as it is in Fortress; it must already exist (and be the only department with that code), and fills the site when that is empty' }),
      { key: 'active', label: 'Active', type: 'boolean', description: 'Yes / no; empty keeps them active. Linking an employee to a sign-in stays a person\'s step' },
    ],
  },
  {
    entityType: 'gauge_type',
    label: 'Gauge types',
    keyHint: 'The gauge type code',
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true, maxLength: 40, description: 'Identifies the gauge type; unique in Fortress' },
      { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 100, description: 'Unique in Fortress' },
      { key: 'description', label: 'Description', type: 'text', maxLength: 1000 },
      { key: 'intervalValue', label: 'Calibration interval', type: 'integer', description: 'A whole number from 1 to 3650; empty means 12' },
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
      ref('gaugeType', 'Gauge type', 'gauge_type', 'gauge type code', { description: 'The gauge type code in Fortress, or the id your source gave it when it was imported here; it gives the gauge its characteristics' }),
      { key: 'manufacturer', label: 'Manufacturer', type: 'text', maxLength: 100 },
      { key: 'model', label: 'Model', type: 'text', maxLength: 100 },
      { key: 'serialNumber', label: 'Serial number', type: 'text', maxLength: 100 },
      ref('site', 'Site', 'site', 'site code'),
      ref('department', 'Department', 'department', 'department code'),
      { key: 'location', label: 'Location', type: 'text', maxLength: 200 },
      { key: 'rangeMin', label: 'Range from', type: 'number' },
      { key: 'rangeMax', label: 'Range to', type: 'number' },
      ref('unit', 'Unit', 'unit', 'unit code', { maxLength: 20, description: 'A unit code Fortress knows, such as mm' }),
      { key: 'resolution', label: 'Resolution', type: 'number', description: 'Greater than 0' },
      { key: 'calibrationSource', label: 'Calibrated', type: 'enum', options: options(['internal', 'external']), description: 'Internal or external; empty means internal' },
      ref('supplier', 'Calibration supplier', 'supplier', 'supplier code'),
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
      ref('category', 'Category', 'category', 'category code', { description: 'A category code such as PRODUCT or PROCESS; it must already exist' }),
      { key: 'severity', label: 'Severity', type: 'enum', options: options(['critical', 'major', 'minor']) },
      { key: 'description', label: 'Description', type: 'text', maxLength: 5000 },
      { key: 'requirement', label: 'Requirement', type: 'text', maxLength: 2000 },
      { key: 'actualResult', label: 'Actual result', type: 'text', maxLength: 2000 },
      { key: 'detectedAt', label: 'Detected on', type: 'date' },
      ref('site', 'Site', 'site', 'site code'),
      ref('part', 'Part number', 'part', 'part number'),
      ref('customer', 'Customer', 'customer', 'customer code', { description: 'Needed when the source is Customer' }),
      ref('supplier', 'Supplier', 'supplier', 'supplier code', { description: 'Needed when the source is Supplier' }),
      ref('detectionMachine', 'Where detected', 'machine', 'machine code'),
      ref('causalMachine', 'Causal process', 'machine', 'machine code'),
      ref('responsibleEmployee', 'Responsible employee', 'employee', 'employee number'),
      { key: 'quantityAffected', label: 'Quantity affected', type: 'number' },
      { key: 'quantityInspected', label: 'Quantity inspected', type: 'number' },
      { key: 'workOrder', label: 'Work order', type: 'text', maxLength: 60 },
      { key: 'purchaseOrder', label: 'Purchase order', type: 'text', maxLength: 60 },
      { key: 'customerReference', label: 'Customer reference', type: 'text', maxLength: 60 },
      { key: 'lotNumber', label: 'Lot number', type: 'text', maxLength: 60 },
      { key: 'serialNumber', label: 'Serial number', type: 'text', maxLength: 60, description: 'Imported non-conformances arrive as drafts with a Fortress reference; opening, moving and closing them stay a person\'s steps' },
    ],
  },
  {
    entityType: 'production_order',
    label: 'Production orders',
    keyHint: 'The order number in your ERP',
    fields: [
      { key: 'orderNumber', label: 'Order number', type: 'text', required: true, maxLength: 60, description: 'Unique in Fortress' },
      ref('part', 'Part number', 'part', 'part number', { required: true }),
      { key: 'partRevision', label: 'Part revision', type: 'text', maxLength: 20, description: 'The revision letter of the part as it is in Fortress (the released version is used)' },
      ref('customer', 'Customer', 'customer', 'customer code'),
      ref('site', 'Site', 'site', 'site code'),
      { key: 'quantityPlanned', label: 'Quantity planned', type: 'number', required: true, description: 'Greater than 0' },
      { key: 'dueDate', label: 'Due date', type: 'date' },
      {
        key: 'status',
        label: 'Status',
        type: 'enum',
        options: options(PRODUCTION_STATUSES),
        description: 'Translate your system\'s statuses to these. A new order keeps it; a later import moves the order one allowed step at a time, so an order with open operations cannot complete and a closed or cancelled one never changes',
      },
      { key: 'statusReason', label: 'Reason cancelled', type: 'text', maxLength: 1000, description: 'Kept when the order is cancelled; "Cancelled in the source system" when empty' },
      { key: 'notes', label: 'Notes', type: 'text', maxLength: 2000 },
    ],
  },
  {
    entityType: 'purchase_order',
    label: 'Purchase orders',
    keyHint: 'The order number; Fortress adds the line number, so each order line is one row',
    keySuffix: 'lineNumber',
    fields: [
      { key: 'poNumber', label: 'Order number', type: 'text', required: true, maxLength: 40, noReview: true, description: 'Lines with the same number belong to one order' },
      { key: 'lineNumber', label: 'Line number', type: 'integer', required: true, min: 1, noReview: true, description: 'The line on the order; with the order number it identifies the line' },
      ref('supplier', 'Supplier', 'supplier', 'supplier code', { required: true, noReview: true, description: 'The supplier code in Fortress, or the id your source gave it when it was imported here; an order\'s supplier never changes' }),
      { key: 'orderedOn', label: 'Ordered on', type: 'date', description: 'Empty means the requested date of its first line' },
      ref('part', 'Part number', 'part', 'part number', { description: 'A part of ours, or give the material instead' }),
      { key: 'material', label: 'Material or service', type: 'text', maxLength: 200, description: 'In words, when the line is not one of our parts' },
      { key: 'quantityOrdered', label: 'Quantity ordered', type: 'number', required: true, description: 'Greater than 0' },
      { key: 'unit', label: 'Unit', type: 'text', maxLength: 20 },
      { key: 'requestedOn', label: 'Requested date', type: 'date', required: true, noReview: true, description: 'The date first asked for. Set when the line is created and never changed by a later import (on-time delivery can be measured against it)' },
      { key: 'agreedOn', label: 'Agreed date', type: 'date', description: 'The latest date agreed with the supplier; follows the source' },
      { key: 'lineStatus', label: 'Line status', type: 'enum', options: options(['open', 'closed', 'cancelled']), description: 'Empty means open. The order follows its lines: open while any line is open, else closed (cancelled when every line is)' },
      { key: 'orderNotes', label: 'Order notes', type: 'text', maxLength: 2000 },
      { key: 'quantityReceived', label: 'Received so far', type: 'number', min: 0, noReview: true, description: 'The source\'s own total received on the line; kept for the received quantities check, nothing is recorded as received from it' },
      { key: 'lastReceivedOn', label: 'Last received on', type: 'date', noReview: true, description: 'The source\'s last delivery date for the line, for the same check' },
    ],
  },
  {
    entityType: 'goods_receipt',
    label: 'Goods receipts',
    keyHint: 'The transaction id of each delivery (or return) in your system',
    fields: [
      { key: 'documentNumber', label: 'Receipt document', type: 'text', maxLength: 100, noReview: true, description: 'Rows with the same document from the same supplier are one delivery; empty makes each row its own' },
      ref('supplier', 'Supplier', 'supplier', 'supplier code', { noReview: true, description: 'The supplier code in Fortress, or the id your source gave it when it was imported here; not needed when the order is given' }),
      { key: 'poNumber', label: 'Order number', type: 'text', maxLength: 40, noReview: true, description: 'The purchase order, already in Fortress (import purchase orders first)' },
      { key: 'poLine', label: 'Order line', type: 'integer', min: 1, noReview: true, description: 'Not needed when the order has one line' },
      { key: 'receivedOn', label: 'Received on', type: 'date', required: true, noReview: true, description: 'The real date it arrived (or went back); not in the future' },
      { key: 'deliveryNote', label: 'Delivery note', type: 'text', maxLength: 100 },
      ref('part', 'Part number', 'part', 'part number', { noReview: true, description: 'Taken from the order line when empty' }),
      { key: 'material', label: 'Material or service', type: 'text', maxLength: 200, noReview: true },
      { key: 'quantity', label: 'Quantity', type: 'number', required: true, noReview: true, description: 'What arrived. Below zero (or with movement Return) it is a return: it becomes a rejection of that quantity on the latest earlier delivery it matches' },
      { key: 'movement', label: 'Movement', type: 'enum', options: options(['receipt', 'return']), noReview: true, description: 'Empty follows the sign of the quantity' },
      { key: 'lotNumber', label: 'Lot number', type: 'text', maxLength: 60, noReview: true, description: 'Makes the lot of the part, already released; the same lot delivered again is the same lot' },
      ref('site', 'Site', 'site', 'site code', { noReview: true, description: 'Empty means the organisation\'s only site' }),
      { key: 'notes', label: 'Notes', type: 'text', maxLength: 1000 },
      { key: 'leaveOut', label: 'Leave this row out', type: 'boolean', noReview: true, description: 'Yes leaves the row out of the import, listed as skipped (for example transfers or adjustments in an inventory export); a formula such as IN([Type], "TRF", "ADJ") fits' },
    ],
  },
  {
    entityType: 'po_receipt_total',
    label: 'Received quantities',
    keyHint: 'The order number; Fortress adds the line number, so each order line is one row',
    keySuffix: 'poLine',
    fields: [
      { key: 'poNumber', label: 'Order number', type: 'text', required: true, maxLength: 40, noReview: true, description: 'The purchase order, already in Fortress (import purchase orders first)' },
      { key: 'poLine', label: 'Order line', type: 'integer', required: true, min: 1, noReview: true },
      { key: 'quantityReceived', label: 'Received so far', type: 'number', required: true, min: 0, noReview: true, description: 'The total received on the line. When it is more than Fortress has, a delivery of the difference is recorded; when less, nothing is, and the received quantities check lists it' },
      { key: 'lastReceivedOn', label: 'Last received on', type: 'date', noReview: true, description: 'Dates the delivery of the difference; needed when the total goes up' },
      { key: 'deliveryNote', label: 'Delivery note', type: 'text', maxLength: 100, noReview: true },
    ],
  },
];

export const catalogueFor = (entity: string): EntityCatalogue | undefined => CATALOGUE.find((c) => c.entityType === entity);
