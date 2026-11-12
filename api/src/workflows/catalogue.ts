/**
 * What a workflow rule can start from and test (WF1). Mirrors `app.workflow_triggers()`; each trigger's fields are the keys `app.system_workflow_facts` returns.
 * A field is `enum` (one of fixed values; `in` / `not_in` / `eq` / `ne`), `ordered` (an enum with an order: also `gte` / `lte`), `ref` (an id of a record of that
 * kind) or `text`. Everything can be tested for being `empty` / `not_empty`.
 */
export type FieldType = 'enum' | 'ordered' | 'ref' | 'text';
export interface TriggerField {
  key: string;
  label: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  ref?: 'part' | 'part_family' | 'supplier' | 'customer' | 'machine' | 'site' | 'gauge_type';
}
export interface Trigger {
  eventType: string;
  entityType: string;
  label: string;
  permission: string;
  fields: TriggerField[];
}

const o = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));
export const SEVERITY = o(['minor', 'Minor'], ['major', 'Major'], ['critical', 'Critical']);
const NC_SOURCE = o(
  ['internal', 'Internal'], ['customer', 'Customer'], ['supplier', 'Supplier'], ['internal_audit', 'Internal audit'], ['external_audit', 'External audit'],
  ['production_inspection', 'Production inspection'], ['final_inspection', 'Final inspection'], ['calibration', 'Calibration'], ['goods_receiving', 'Goods receiving'],
  ['engineering', 'Engineering'], ['management_review', 'Management review'],
);
const NC_STAGE = o(
  ['draft', 'Draft'], ['open', 'Open'], ['contained', 'Contained'], ['investigating', 'Investigating'], ['dispositioned', 'Dispositioned'],
  ['awaiting_closure', 'Awaiting closure'], ['closed', 'Closed'], ['cancelled', 'Cancelled'],
);
const NC_FIELDS: TriggerField[] = [
  { key: 'severity', label: 'Severity', type: 'ordered', options: SEVERITY },
  { key: 'source', label: 'Source', type: 'enum', options: NC_SOURCE },
  { key: 'category', label: 'Category (code)', type: 'text' },
  { key: 'site_id', label: 'Site', type: 'ref', ref: 'site' },
  { key: 'part_id', label: 'Part', type: 'ref', ref: 'part' },
  { key: 'part_family_id', label: 'Part family', type: 'ref', ref: 'part_family' },
  { key: 'supplier_id', label: 'Supplier', type: 'ref', ref: 'supplier' },
  { key: 'customer_id', label: 'Customer', type: 'ref', ref: 'customer' },
];

export const TRIGGERS: Trigger[] = [
  { eventType: 'ncr.created', entityType: 'nonconformance', label: 'A non-conformance is raised', permission: 'ncr.read', fields: NC_FIELDS },
  {
    eventType: 'ncr.stage_changed',
    entityType: 'nonconformance',
    label: 'A non-conformance moves to another stage',
    permission: 'ncr.read',
    fields: [{ key: 'to_stage', label: 'Moved to', type: 'enum', options: NC_STAGE }, ...NC_FIELDS],
  },
  {
    eventType: 'inspection.measurement.failed',
    entityType: 'inspection_measurement',
    label: 'An inspection reading fails',
    permission: 'inspection.read',
    fields: [
      { key: 'criticality', label: 'Characteristic criticality', type: 'ordered', options: SEVERITY },
      { key: 'characteristic_key', label: 'Characteristic (key)', type: 'text' },
      { key: 'operation_code', label: 'Operation', type: 'text' },
      { key: 'machine_id', label: 'Machine', type: 'ref', ref: 'machine' },
      { key: 'part_id', label: 'Part', type: 'ref', ref: 'part' },
      { key: 'part_family_id', label: 'Part family', type: 'ref', ref: 'part_family' },
      { key: 'site_id', label: 'Site', type: 'ref', ref: 'site' },
      { key: 'trigger_type', label: 'Kind of inspection', type: 'enum', options: o(
          ['first_off', 'First off'], ['last_off', 'Last off'], ['every_n_minutes', 'Every N minutes'], ['every_n_parts', 'Every N parts'], ['start_of_shift', 'Start of shift'],
          ['after_tool_change', 'After a tool change'], ['after_setup', 'After set-up'], ['manual', 'By hand'], ['incoming', 'Incoming'],
        ) },
    ],
  },
  {
    eventType: 'calibration.recorded',
    entityType: 'calibration',
    label: 'A calibration is recorded',
    permission: 'calibration.read',
    fields: [
      { key: 'outcome', label: 'Outcome', type: 'enum', options: o(['pass', 'Pass'], ['adjusted', 'Adjusted'], ['fail', 'Fail']) },
      { key: 'gauge_type_id', label: 'Gauge type', type: 'ref', ref: 'gauge_type' },
      { key: 'site_id', label: 'Site', type: 'ref', ref: 'site' },
    ],
  },
  {
    eventType: 'gauge.status_changed',
    entityType: 'gauge',
    label: 'A gauge changes status',
    permission: 'calibration.read',
    fields: [
      {
        key: 'status',
        label: 'New status',
        type: 'enum',
        options: o(['active', 'Active'], ['in_calibration', 'In calibration'], ['quarantined', 'Quarantined'], ['out_of_service', 'Out of service'], ['retired', 'Retired'], ['lost', 'Lost']),
      },
      { key: 'gauge_type_id', label: 'Gauge type', type: 'ref', ref: 'gauge_type' },
      { key: 'site_id', label: 'Site', type: 'ref', ref: 'site' },
    ],
  },
  {
    eventType: 'capa.created',
    entityType: 'capa',
    label: 'An 8D is started',
    permission: 'capa.read',
    fields: [
      { key: 'severity', label: 'Severity', type: 'ordered', options: SEVERITY },
      { key: 'source', label: 'Source', type: 'enum', options: o(['internal', 'Internal'], ['customer', 'Customer'], ['supplier', 'Supplier']) },
    ],
  },
  {
    eventType: 'audit.finding.created',
    entityType: 'audit_finding',
    label: 'An audit finding is raised',
    permission: 'audits.read',
    fields: [
      { key: 'finding_kind', label: 'Kind of finding', type: 'enum', options: o(['nonconformity', 'Non-conformity'], ['observation', 'Observation'], ['opportunity', 'Opportunity for improvement']) },
      { key: 'classification', label: 'Classification (key)', type: 'text' },
    ],
  },
  {
    eventType: 'supplier.approval_status_changed',
    entityType: 'supplier',
    label: "A supplier's approval status changes",
    permission: 'supplier_quality.read',
    fields: [
      {
        key: 'approval_status',
        label: 'New approval status',
        type: 'enum',
        options: o(['pending_approval', 'Pending approval'], ['approved', 'Approved'], ['conditional', 'Conditional'], ['suspended', 'Suspended'], ['disqualified', 'Disqualified'], ['archived', 'Archived']),
      },
      { key: 'risk_rating', label: 'Risk rating', type: 'enum', options: o(['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['critical', 'Critical']) },
      { key: 'supplier_id', label: 'Supplier', type: 'ref', ref: 'supplier' },
    ],
  },
];

export const triggerFor = (eventType: string) => TRIGGERS.find((t) => t.eventType === eventType);

/** Where a record behind a rule's run leads in the web app. Built only from known kinds and a UUID (used in emails too). Mirrored in src/lib/workflows.js. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function workflowRecordPath(kind: unknown, id: unknown): string | null {
  const t = typeof id === 'string' && UUID.test(id) ? id : null;
  if (!t) return null;
  switch (kind) {
    case 'nonconformance':
      return `/Non-Conformance/Register/${t}`;
    case 'inspection':
      return `/Inspections/${t}`;
    case 'gauge':
      return `/Calibration/Gauges/${t}`;
    case 'capa':
      return `/CAPA/${t}/d0`;
    case 'audit_finding':
      return `/Audits/Findings/${t}`;
    case 'supplier':
      return `/Suppliers/${t}`;
    default:
      return null;
  }
}
