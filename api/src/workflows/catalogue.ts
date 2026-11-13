/**
 * What a workflow rule can start from and test (WF1). Mirrors `app.workflow_triggers()`; each trigger's fields are the keys `app.system_workflow_facts` returns.
 * A field is `enum` (one of fixed values; `in` / `not_in` / `eq` / `ne`), `ordered` (an enum with an order: also `gte` / `lte`), `ref` (an id of a record of that
 * kind), `text` (also `contains` / `not_contains`) or `number` (`eq` / `ne` / `gt` / `lt` / `gte` / `lte`). Everything can be tested for being `empty` / `not_empty`.
 */
export type FieldType = 'enum' | 'ordered' | 'ref' | 'text' | 'number';
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
  { key: 'stage', label: 'Stage', type: 'enum', options: NC_STAGE },
  { key: 'source', label: 'Source', type: 'enum', options: NC_SOURCE },
  { key: 'category', label: 'Category (code)', type: 'text' },
  { key: 'site_id', label: 'Site', type: 'ref', ref: 'site' },
  { key: 'part_id', label: 'Part', type: 'ref', ref: 'part' },
  { key: 'part_family_id', label: 'Part family', type: 'ref', ref: 'part_family' },
  { key: 'supplier_id', label: 'Supplier', type: 'ref', ref: 'supplier' },
  { key: 'customer_id', label: 'Customer', type: 'ref', ref: 'customer' },
  { key: 'quantity_affected', label: 'Quantity affected', type: 'number' },
  { key: 'total_cost', label: 'Total cost (base currency)', type: 'number' },
  { key: 'title', label: 'Title', type: 'text' },
];
const RISK_BAND = o(['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['critical', 'Critical']);
const SCORE_BAND = o(['poor', 'Poor'], ['watch', 'Watch'], ['good', 'Good']);
const PERIOD_KIND = o(['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['annual', 'Annual']);
const CAPA_STAGE = o(['open', 'Open'], ['actions_in_progress', 'Actions in progress'], ['awaiting_verification', 'Awaiting verification'], ['verified_effective', 'Verified effective'], ['closed', 'Closed'], ['cancelled', 'Cancelled']);
const CAPA_FIELDS: TriggerField[] = [
  { key: 'severity', label: 'Severity', type: 'ordered', options: SEVERITY },
  { key: 'source', label: 'Source', type: 'enum', options: o(['internal', 'Internal'], ['customer', 'Customer'], ['supplier', 'Supplier']) },
  { key: 'stage', label: 'Stage', type: 'enum', options: CAPA_STAGE },
  { key: 'title', label: 'Title', type: 'text' },
];
const SUPPLIER_STATUS = o(['pending_approval', 'Pending approval'], ['approved', 'Approved'], ['conditional', 'Conditional'], ['suspended', 'Suspended'], ['disqualified', 'Disqualified'], ['archived', 'Archived']);
const SCAR_STATUS = o(
  ['draft', 'Draft'], ['issued', 'Issued'], ['acknowledged', 'Acknowledged'], ['response_received', 'Response received'], ['under_review', 'Under review'],
  ['revision_requested', 'Revision requested'], ['accepted', 'Accepted'], ['verifying', 'Verifying'], ['closed', 'Closed'], ['cancelled', 'Cancelled'],
);
const PLAN_STATUS = o(['draft', 'Draft'], ['pending_approval', 'Pending approval'], ['approved', 'Approved'], ['effective', 'Effective'], ['superseded', 'Superseded'], ['obsolete', 'Obsolete']);

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
    eventType: 'ncr.disposition.approved',
    entityType: 'ncr_disposition',
    label: 'A disposition is approved on a non-conformance',
    permission: 'ncr.read',
    fields: [
      {
        key: 'decision',
        label: 'Decision',
        type: 'enum',
        options: o(['rework', 'Rework'], ['repair', 'Repair'], ['scrap', 'Scrap'], ['use_as_is', 'Use as is'], ['return_to_supplier', 'Return to supplier'], ['concession', 'Concession'], ['customer_return', 'Customer return (RMA)']),
      },
      { key: 'disposition_quantity', label: 'Quantity disposed', type: 'number' },
      ...NC_FIELDS,
    ],
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
      { key: 'work_order', label: 'Work order', type: 'text' },
      { key: 'lot', label: 'Lot', type: 'text' },
    ],
  },
  {
    eventType: 'spc.alert.raised',
    entityType: 'spc_alert',
    label: 'An SPC alert is raised',
    permission: 'spc.read',
    fields: [
      { key: 'rule', label: 'Rule', type: 'enum', options: o(['we1', 'A point beyond the control limits'], ['we2', 'Two of three beyond 2σ'], ['we3', 'Four of five beyond 1σ'], ['we4', 'Eight in a row on one side'], ['range', 'Range or moving range out of control']) },
      { key: 'variant', label: 'Chart', type: 'enum', options: o(['imr', 'I-MR'], ['xbar_r', 'X-bar / R'], ['p', 'P'], ['c', 'C'], ['u', 'U']) },
      { key: 'side', label: 'Side', type: 'enum', options: o(['above', 'Above'], ['below', 'Below']) },
      { key: 'characteristic_key', label: 'Characteristic (key)', type: 'text' },
      { key: 'operation_code', label: 'Operation', type: 'text' },
      { key: 'part_id', label: 'Part', type: 'ref', ref: 'part' },
      { key: 'part_family_id', label: 'Part family', type: 'ref', ref: 'part_family' },
      { key: 'machine_id', label: 'Machine', type: 'ref', ref: 'machine' },
      { key: 'site_id', label: 'Site', type: 'ref', ref: 'site' },
    ],
  },
  {
    eventType: 'control_plan.revision.status_changed',
    entityType: 'control_plan_revision',
    label: 'A control plan revision changes status',
    permission: 'process_control.read',
    fields: [
      { key: 'to_status', label: 'Moved to', type: 'enum', options: PLAN_STATUS },
      { key: 'from_status', label: 'Moved from', type: 'enum', options: PLAN_STATUS },
      { key: 'plan_code', label: 'Plan code', type: 'text' },
    ],
  },
  {
    eventType: 'part.revision.released',
    entityType: 'part_revision',
    label: 'A part revision is released',
    permission: 'master_data.read',
    fields: [
      { key: 'part_id', label: 'Part', type: 'ref', ref: 'part' },
      { key: 'part_family_id', label: 'Part family', type: 'ref', ref: 'part_family' },
      { key: 'revision', label: 'Revision', type: 'text' },
    ],
  },
  {
    eventType: 'calibration.recorded',
    entityType: 'calibration',
    label: 'A calibration is recorded',
    permission: 'calibration.read',
    fields: [
      { key: 'outcome', label: 'Outcome', type: 'enum', options: o(['pass', 'Pass'], ['adjusted', 'Adjusted'], ['fail', 'Fail']) },
      { key: 'performed_by', label: 'Calibrated', type: 'enum', options: o(['internal', 'In house'], ['external', 'By an outside laboratory']) },
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
    fields: CAPA_FIELDS,
  },
  {
    eventType: 'capa.verified',
    entityType: 'capa',
    label: "An 8D's actions are verified",
    permission: 'capa.read',
    fields: [{ key: 'effective', label: 'Found effective', type: 'enum', options: o(['yes', 'Yes'], ['no', 'No']) }, ...CAPA_FIELDS],
  },
  { eventType: 'capa.closed', entityType: 'capa', label: 'An 8D is closed', permission: 'capa.read', fields: CAPA_FIELDS },
  {
    eventType: 'audit.completed',
    entityType: 'audit_record',
    label: 'An audit is completed',
    permission: 'audits.read',
    fields: [
      { key: 'result', label: 'Result', type: 'enum', options: o(['pass', 'Pass'], ['fail', 'Fail']) },
      { key: 'score', label: 'Score (%)', type: 'number' },
      { key: 'failed', label: 'Questions failed', type: 'number' },
      { key: 'critical_failed', label: 'Critical questions failed', type: 'number' },
      { key: 'audit_type', label: 'Type of audit', type: 'text' },
      { key: 'supplier_id', label: 'Carried out on supplier', type: 'ref', ref: 'supplier' },
      { key: 'machine_id', label: 'Carried out on machine', type: 'ref', ref: 'machine' },
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
      { key: 'title', label: 'Title', type: 'text' },
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
        options: SUPPLIER_STATUS,
      },
      { key: 'risk_rating', label: 'Risk rating', type: 'ordered', options: RISK_BAND },
      { key: 'supplier_id', label: 'Supplier', type: 'ref', ref: 'supplier' },
    ],
  },
  {
    eventType: 'supplier.risk_assessed',
    entityType: 'supplier',
    label: "A supplier's risk is assessed",
    permission: 'supplier_quality.read',
    fields: [
      { key: 'risk_rating', label: 'New risk rating', type: 'ordered', options: RISK_BAND },
      { key: 'previous_risk_rating', label: 'Rating before', type: 'ordered', options: RISK_BAND },
      { key: 'approval_status', label: 'Approval status', type: 'enum', options: SUPPLIER_STATUS },
      { key: 'supplier_id', label: 'Supplier', type: 'ref', ref: 'supplier' },
    ],
  },
  {
    eventType: 'supplier.band_dropped',
    entityType: 'supplier_band_drop',
    label: "A supplier's scorecard band falls",
    permission: 'supplier_quality.read',
    fields: [
      { key: 'to_band', label: 'Fell to', type: 'ordered', options: SCORE_BAND },
      { key: 'from_band', label: 'Fell from', type: 'ordered', options: SCORE_BAND },
      { key: 'period_kind', label: 'Scorecard period', type: 'enum', options: PERIOD_KIND },
      { key: 'score', label: 'Score', type: 'number' },
      { key: 'risk_rating', label: 'Risk rating', type: 'ordered', options: RISK_BAND },
      { key: 'approval_status', label: 'Approval status', type: 'enum', options: SUPPLIER_STATUS },
      { key: 'supplier_id', label: 'Supplier', type: 'ref', ref: 'supplier' },
    ],
  },
  {
    eventType: 'scar.status_changed',
    entityType: 'scar',
    label: 'A SCAR changes status',
    permission: 'supplier_quality.read',
    fields: [
      { key: 'to_status', label: 'Moved to', type: 'enum', options: SCAR_STATUS },
      { key: 'from_status', label: 'Moved from', type: 'enum', options: SCAR_STATUS },
      { key: 'severity', label: 'Severity', type: 'ordered', options: SEVERITY },
      { key: 'supplier_id', label: 'Supplier', type: 'ref', ref: 'supplier' },
      { key: 'title', label: 'Title', type: 'text' },
    ],
  },
  {
    eventType: 'receipt.line.decided',
    entityType: 'receipt_line_disposition',
    label: 'A decision is made on a received line',
    permission: 'receiving.read',
    fields: [
      { key: 'decision', label: 'Decision', type: 'enum', options: o(['held', 'Held'], ['accepted', 'Accepted'], ['rejected', 'Rejected'], ['conditional', 'Accepted with conditions']) },
      { key: 'quantity_received', label: 'Quantity received', type: 'number' },
      { key: 'quantity_rejected', label: 'Quantity rejected', type: 'number' },
      { key: 'supplier_id', label: 'Supplier', type: 'ref', ref: 'supplier' },
      { key: 'part_id', label: 'Part', type: 'ref', ref: 'part' },
      { key: 'part_family_id', label: 'Part family', type: 'ref', ref: 'part_family' },
      { key: 'site_id', label: 'Site', type: 'ref', ref: 'site' },
    ],
  },
  {
    eventType: 'risk.assessed',
    entityType: 'risk_assessment',
    label: 'A risk is assessed',
    permission: 'risk.read',
    fields: [
      { key: 'band', label: 'Level', type: 'ordered', options: RISK_BAND },
      { key: 'previous_band', label: 'Level before', type: 'ordered', options: RISK_BAND },
      { key: 'score', label: 'Score (1–25)', type: 'number' },
      { key: 'phase', label: 'Assessed', type: 'enum', options: o(['inherent', 'Before treatment'], ['residual', 'After treatment']) },
      { key: 'kind', label: 'Kind', type: 'enum', options: o(['risk', 'Risk'], ['opportunity', 'Opportunity']) },
      { key: 'category', label: 'Category (key)', type: 'text' },
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'site_id', label: 'Site', type: 'ref', ref: 'site' },
    ],
  },
  {
    eventType: 'quality_alert.issued',
    entityType: 'quality_alert',
    label: 'A quality alert is issued',
    permission: 'documentation.read',
    fields: [
      { key: 'severity', label: 'Severity', type: 'ordered', options: RISK_BAND },
      { key: 'category', label: 'Category', type: 'enum', options: o(['product', 'Product'], ['process', 'Process'], ['supplier', 'Supplier'], ['equipment', 'Equipment'], ['safety', 'Safety']) },
      { key: 'revision', label: 'Revision number', type: 'number' },
      { key: 'title', label: 'Title', type: 'text' },
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
    case 'audit_record':
      return `/Audits/Records/${t}`;
    case 'part':
      return `/Parts/${t}`;
    case 'control_plan':
      return `/Process-Control/Plans/${t}`;
    case 'spc_alert':
      return '/Process-Control/Alerts';
    case 'goods_receipt':
      return `/Supplier-Quality/Goods-Receipts/${t}`;
    case 'scar':
      return `/Supplier-Quality/SCARs/${t}`;
    case 'risk':
      return `/Risk/Register/${t}`;
    case 'quality_alert':
      return `/Documentation/Quality-Alerts/${t}`;
    default:
      return null;
  }
}
