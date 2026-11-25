/**
 * The reporting datasets (docs/reporting-api-plan.md): one flat view each, with the columns in the view's own order. This list is the contract with
 * whatever reads the data: a column is added here only on purpose, and the e2e test fails when it and the database's views differ.
 *
 * Types decide how a value is written to JSON, so every reader gets the same thing whatever the database driver would have done:
 *  text; number (a JSON number); date ("2026-11-23"); datetime (ISO 8601 UTC with microseconds, "2026-11-23T10:51:34.123456Z"); boolean; json (nested).
 */
export type ColumnType = 'text' | 'number' | 'date' | 'datetime' | 'boolean' | 'json';

export interface DatasetColumn {
  name: string;
  type: ColumnType;
  description: string;
}

export interface Dataset {
  key: string;
  view: string;
  title: string;
  description: string;
  /** What the person (whose key it is) must be able to read; row-level security then decides which rows. */
  permission: string;
  columns: DatasetColumn[];
}

const c = (name: string, type: ColumnType, description: string): DatasetColumn => ({ name, type, description });

export const DATASETS: Dataset[] = [
  {
    key: 'non_conformances',
    view: 'report_non_conformances',
    title: 'Non-conformances',
    description: 'One row per non-conformance (deleted ones left out), with its total cost in the organisation currency.',
    permission: 'ncr.read',
    columns: [
      c('id', 'text', 'Fortress id of the non-conformance'),
      c('reference', 'text', 'Reference, e.g. SNC-26-0011'),
      c('title', 'text', 'Title'),
      c('source', 'text', 'Where it came from or was detected (internal, customer, supplier, internal_audit, …)'),
      c('stage', 'text', 'Stage (draft, open, contained, investigating, dispositioned, awaiting_closure, closed, cancelled)'),
      c('severity', 'text', 'minor, major or critical'),
      c('category', 'text', 'Category (what the problem is)'),
      c('failure_mode', 'text', 'Failure mode'),
      c('sub_failure_mode', 'text', 'Sub failure mode'),
      c('description', 'text', 'Description'),
      c('requirement', 'text', 'The requirement'),
      c('actual_result', 'text', 'The actual result'),
      c('site_code', 'text', 'Site code'),
      c('site', 'text', 'Site'),
      c('part_number', 'text', 'Part number'),
      c('part_name', 'text', 'Part name'),
      c('customer_code', 'text', 'Customer code'),
      c('customer', 'text', 'Customer'),
      c('supplier_code', 'text', 'Supplier code'),
      c('supplier', 'text', 'Supplier'),
      c('work_order', 'text', 'Work order'),
      c('purchase_order', 'text', 'Purchase order'),
      c('customer_reference', 'text', 'Customer reference'),
      c('lot_number', 'text', 'Lot number'),
      c('serial_number', 'text', 'Serial number'),
      c('quantity_affected', 'number', 'Quantity affected'),
      c('quantity_inspected', 'number', 'Quantity inspected'),
      c('detected_on', 'date', 'Date detected'),
      c('raised_at', 'datetime', 'When it was raised in Fortress'),
      c('closed_at', 'datetime', 'When it was closed'),
      c('detected_at_machine', 'text', 'Where detected (machine)'),
      c('causal_machine', 'text', 'Causal process (machine)'),
      c('responsible_department', 'text', 'Responsible department'),
      c('detected_by', 'text', 'Who detected it (employee)'),
      c('responsible_employee', 'text', 'Responsible employee'),
      c('cost_currency', 'text', 'Currency of total_cost (the organisation currency)'),
      c('total_cost', 'number', 'Total cost in the organisation currency; credits (supplier recoveries) subtract'),
      c('cost_lines', 'number', 'Number of cost lines'),
      c('cost_lines_waiting_for_rate', 'number', 'Cost lines with no exchange rate yet (not in total_cost)'),
      c('updated_at', 'datetime', 'Last change to the non-conformance or its costs'),
    ],
  },
  {
    key: 'non_conformance_costs',
    view: 'report_non_conformance_costs',
    title: 'Non-conformance costs',
    description: 'One row per cost line. Amounts are signed (credits negative) so a sum is right; a line still waiting for an exchange rate has no converted amount.',
    permission: 'ncr.read',
    columns: [
      c('id', 'text', 'Fortress id of the cost line'),
      c('non_conformance_id', 'text', 'Fortress id of the non-conformance'),
      c('non_conformance_reference', 'text', 'Reference of the non-conformance'),
      c('non_conformance_title', 'text', 'Title of the non-conformance'),
      c('cost_type', 'text', 'Type of cost'),
      c('description', 'text', 'Description'),
      c('incurred_on', 'date', 'Date the cost was incurred'),
      c('entered_currency', 'text', 'Currency the amount was entered in'),
      c('quantity', 'number', 'Quantity'),
      c('unit_cost', 'number', 'Unit cost in the entered currency'),
      c('entered_amount', 'number', 'Quantity × unit cost in the entered currency'),
      c('vat_treatment', 'text', 'VAT treatment'),
      c('vat_rate', 'number', 'VAT rate'),
      c('site_currency', 'text', 'The site’s currency'),
      c('net_site_currency', 'number', 'Net amount in the site currency, signed'),
      c('organisation_currency', 'text', 'The organisation’s currency'),
      c('net_organisation_currency', 'number', 'Net amount in the organisation currency, signed'),
      c('gross_organisation_currency', 'number', 'Gross amount in the organisation currency, signed'),
      c('cost_sign', 'number', '1 for a cost, -1 for a credit'),
      c('rate_status', 'text', 'base, estimated, actual or needed'),
      c('rate_date', 'date', 'The day the exchange rate was published for'),
      c('updated_at', 'datetime', 'Last change to the line'),
    ],
  },
  {
    key: 'suppliers',
    view: 'report_suppliers',
    title: 'Suppliers',
    description: 'One row per supplier.',
    permission: 'supplier_quality.read',
    columns: [
      c('id', 'text', 'Fortress id of the supplier'),
      c('code', 'text', 'Supplier code'),
      c('name', 'text', 'Name'),
      c('display_name', 'text', 'Display name'),
      c('supplier_type', 'text', 'Type'),
      c('approval_status', 'text', 'pending_approval, approved, conditional, suspended, disqualified or archived'),
      c('approval_status_changed_at', 'datetime', 'When the approval status last changed'),
      c('risk_rating', 'text', 'Risk rating (low, medium, high, critical) or empty when not assessed'),
      c('active', 'boolean', 'Whether the supplier is in use'),
      c('country', 'text', 'Country'),
      c('city', 'text', 'Town or city'),
      c('postcode', 'text', 'Postcode'),
      c('currency', 'text', 'Currency trading with the supplier'),
      c('purchasing_reference', 'text', 'Purchasing system reference'),
      c('created_at', 'datetime', 'Created'),
      c('updated_at', 'datetime', 'Last change'),
    ],
  },
  {
    key: 'scars',
    view: 'report_scars',
    title: 'Supplier corrective action requests',
    description: 'One row per SCAR that has been issued (drafts left out).',
    permission: 'supplier_quality.read',
    columns: [
      c('id', 'text', 'Fortress id of the SCAR'),
      c('reference', 'text', 'Reference, e.g. SCAR-26-0001'),
      c('supplier_code', 'text', 'Supplier code'),
      c('supplier', 'text', 'Supplier'),
      c('title', 'text', 'Title'),
      c('severity', 'text', 'minor, major or critical'),
      c('status', 'text', 'Status'),
      c('original_response_due_on', 'date', 'The response due date when it was issued'),
      c('response_due_on', 'date', 'The response due date now (after any agreed extension)'),
      c('issued_at', 'datetime', 'Issued'),
      c('acknowledged_at', 'datetime', 'Acknowledged by the supplier'),
      c('closed_at', 'datetime', 'Closed'),
      c('cancelled_at', 'datetime', 'Cancelled'),
      c('response_overdue', 'boolean', 'A response is awaited and its due date has passed (as at the day of the request, UTC)'),
      c('live_non_conformances', 'number', 'Non-conformances currently linked'),
      c('created_at', 'datetime', 'Created'),
      c('updated_at', 'datetime', 'Last change'),
    ],
  },
  {
    key: 'receipt_lines',
    view: 'report_receipt_lines',
    title: 'Goods receipt lines',
    description: 'One row per received line with its latest incoming-inspection decision. quantity_rejected is what was refused, or the whole line when rejected without a quantity.',
    permission: 'receiving.read',
    columns: [
      c('id', 'text', 'Fortress id of the receipt line'),
      c('receipt_reference', 'text', 'Receipt reference, e.g. GR-26-0001'),
      c('receipt_status', 'text', 'received or cancelled'),
      c('received_on', 'date', 'Date received'),
      c('delivery_note', 'text', 'Delivery note'),
      c('supplier_code', 'text', 'Supplier code'),
      c('supplier', 'text', 'Supplier'),
      c('purchase_order', 'text', 'Purchase order number'),
      c('line_number', 'number', 'Line number on the receipt'),
      c('part_number', 'text', 'Part number'),
      c('part_name', 'text', 'Part name'),
      c('material', 'text', 'Material, when received by description'),
      c('quantity_received', 'number', 'Quantity received'),
      c('lot_number', 'text', 'Lot made from the line'),
      c('latest_decision', 'text', 'held, accepted, rejected or conditional'),
      c('decided_at', 'datetime', 'When the latest decision was made'),
      c('quantity_rejected', 'number', 'Quantity rejected'),
      c('live_non_conformances', 'number', 'Non-conformances currently linked to the line'),
      c('updated_at', 'datetime', 'Last change to the line, its receipt or its decision'),
    ],
  },
  {
    key: 'supplier_scorecards',
    view: 'report_supplier_scorecards',
    title: 'Supplier scorecards',
    description: 'Saved scorecards (by hand or scheduled). The live score is on the supplier’s Performance tab.',
    permission: 'supplier_quality.read',
    columns: [
      c('id', 'text', 'Fortress id of the scorecard'),
      c('supplier_code', 'text', 'Supplier code'),
      c('supplier', 'text', 'Supplier'),
      c('period_kind', 'text', 'monthly, quarterly, annual or empty for one saved by hand'),
      c('period_from', 'date', 'First day of the period'),
      c('period_to', 'date', 'Last day of the period'),
      c('score', 'number', 'Score, 0 to 100, or empty when there was too little data'),
      c('band', 'text', 'good, watch, poor or insufficient'),
      c('model_version', 'number', 'Version of the scoring model used'),
      c('note', 'text', 'Note'),
      c('metrics', 'json', 'The figures behind the score (each with its records)'),
      c('components', 'json', 'The score per measure'),
      c('created_at', 'datetime', 'Saved'),
      c('updated_at', 'datetime', 'Last change'),
    ],
  },
];

export const datasetByKey = (key: string): Dataset | undefined => DATASETS.find((d) => d.key === key);

/** The SELECT list for a dataset: every value cast so it is written the same way whatever the driver does (see ColumnType). */
export function selectList(dataset: Dataset): string {
  return dataset.columns
    .map((col) => {
      const q = `v."${col.name}"`;
      const as = `"${col.name}"`;
      switch (col.type) {
        case 'number':
          return `${q}::float8 as ${as}`;
        case 'date':
          return `to_char(${q}, 'YYYY-MM-DD') as ${as}`;
        case 'datetime':
          return `to_char(${q} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${as}`;
        default:
          return `${q} as ${as}`;
      }
    })
    .join(', ');
}
