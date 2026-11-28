import { EntityType } from './entity-importer';

/**
 * Where each imported field lands, and every other column of the table with the reason it is never imported. This is the one place a schema change has
 * to be reflected: `test/integration-catalogue-drift.e2e-spec.ts` fails when a table gains a column that is in neither list, when a listed column no
 * longer exists, when a catalogue field has no column, or when an import function does not write a column it is said to import.
 * A field can land in another table (a part's revision lands in part_revisions). Reference fields name the id column they fill (their limits are not
 * the code's: the code is looked up, not stored).
 */
export interface FieldColumn {
  column: string;
  table?: string;
  /** The column's own rules do not apply to the source value (a delivery quantity below zero is a return, which never reaches the column). */
  ownRules?: boolean;
}
export interface EntityColumns {
  table: string;
  /** Catalogue field key → the column it fills. */
  fields: Record<string, FieldColumn>;
  /** Columns never imported, with why. */
  excluded: Record<string, string>;
  /** Catalogue fields that fill no column, with what they do instead. */
  virtual?: Record<string, string>;
}

const SYSTEM = {
  id: 'Fortress assigns the id',
  organisation_id: 'The organisation of the connection',
  created_at: 'Set by the database',
  created_by: 'The person who started the import (set by the database)',
  updated_at: 'Set by the database',
  updated_by: 'Set by the database',
};

export const ENTITY_COLUMNS: Partial<Record<EntityType, EntityColumns>> = {
  supplier: {
    table: 'suppliers',
    fields: {
      code: { column: 'code' }, name: { column: 'name' }, displayName: { column: 'display_name' }, companyNumber: { column: 'company_number' },
      vatNumber: { column: 'vat_number' }, notes: { column: 'notes' }, active: { column: 'active' }, supplierType: { column: 'supplier_type' },
      email: { column: 'email' }, phone: { column: 'phone' }, website: { column: 'website' }, addressLine1: { column: 'address_line1' },
      addressLine2: { column: 'address_line2' }, addressLine3: { column: 'address_line3' }, currency: { column: 'currency' }, city: { column: 'city' }, region: { column: 'region' }, postcode: { column: 'postcode' },
      country: { column: 'country' }, purchasingReference: { column: 'purchasing_reference' },
    },
    excluded: {
      ...SYSTEM,
      approval_status: 'Approval is decided in Fortress (a new supplier is always pending approval)',
      approval_status_changed_at: 'Part of the approval decision',
      approval_status_changed_by: 'Part of the approval decision',
      risk_rating: 'Written only by a risk assessment in Fortress',
    },
  },
  customer: {
    table: 'customers',
    fields: {
      code: { column: 'code' }, name: { column: 'name' }, displayName: { column: 'display_name' }, companyNumber: { column: 'company_number' },
      vatNumber: { column: 'vat_number' }, notes: { column: 'notes' }, active: { column: 'active' }, addressLine1: { column: 'address_line1' },
      addressLine2: { column: 'address_line2' }, addressLine3: { column: 'address_line3' }, city: { column: 'city' }, region: { column: 'region' },
      postcode: { column: 'postcode' }, country: { column: 'country' }, currency: { column: 'currency' }, email: { column: 'email' }, phone: { column: 'phone' },
      website: { column: 'website' },
    },
    excluded: { ...SYSTEM },
  },
  part: {
    table: 'parts',
    fields: {
      partNumber: { column: 'part_number' }, name: { column: 'name' }, description: { column: 'description' }, active: { column: 'active' },
      revision: { column: 'revision', table: 'part_revisions' },
    },
    excluded: { ...SYSTEM, part_family_id: 'Families are kept in Fortress (and change control plan scope)' },
  },
  machine: {
    table: 'machines',
    fields: {
      code: { column: 'code' }, name: { column: 'name' }, site: { column: 'site_id' }, workCentre: { column: 'work_centre' },
      description: { column: 'description' }, active: { column: 'active' },
    },
    excluded: { ...SYSTEM },
  },
  employee: {
    table: 'Employees',
    fields: {
      employeeNumber: { column: 'employee_number' }, firstName: { column: 'first_name' }, surname: { column: 'surname' }, jobTitle: { column: 'job_title' },
      email: { column: 'email' }, site: { column: 'site_id' }, department: { column: 'department_id' }, active: { column: 'active' },
    },
    excluded: {
      ...SYSTEM,
      auth_id: 'Linking an employee to a sign-in is a Controller seat holder\'s step',
      avatar: 'A picture is added in Fortress',
      dashboard_range: 'A personal display setting',
    },
  },
  gauge_type: {
    table: 'gauge_types',
    fields: {
      code: { column: 'code' }, name: { column: 'name' }, description: { column: 'description' }, intervalValue: { column: 'interval_value' }, intervalUnit: { column: 'interval_unit' },
      active: { column: 'active' },
    },
    excluded: { ...SYSTEM, procedure_document_id: 'The calibration procedure is a Fortress document, chosen on the type in Fortress' },
  },
  gauge: {
    table: 'gauges',
    fields: {
      assetNumber: { column: 'asset_number' }, description: { column: 'description' }, gaugeType: { column: 'gauge_type_id' }, manufacturer: { column: 'manufacturer' },
      model: { column: 'model' }, serialNumber: { column: 'serial_number' }, site: { column: 'site_id' }, department: { column: 'department_id' },
      machine: { column: 'machine_id' }, location: { column: 'location' }, rangeMin: { column: 'range_min' }, rangeMax: { column: 'range_max' }, unit: { column: 'unit_code' },
      resolution: { column: 'resolution' }, calibrationSource: { column: 'calibration_source' }, supplier: { column: 'supplier_id' },
      intervalValue: { column: 'interval_value' }, intervalUnit: { column: 'interval_unit' }, commissionedOn: { column: 'commissioned_on' }, notes: { column: 'notes' },
    },
    excluded: {
      ...SYSTEM,
      custodian_id: 'A custodian is a Fortress user, chosen in Fortress',
      status: 'Follows the calibrations recorded in Fortress',
      status_reason: 'Follows the calibrations recorded in Fortress',
      status_changed_at: 'Follows the calibrations recorded in Fortress',
      last_calibrated_on: 'Follows the calibrations recorded in Fortress',
      next_due_on: 'Follows the calibrations recorded in Fortress',
      deleted_at: 'Deleting is a person\'s step with a reason',
      deleted_by: 'Deleting is a person\'s step with a reason',
      delete_reason: 'Deleting is a person\'s step with a reason',
    },
  },
  calibration: {
    table: 'calibrations',
    fields: {
      gauge: { column: 'gauge_id' }, calibratedOn: { column: 'calibrated_on' }, outcome: { column: 'outcome' }, nextDueOn: { column: 'next_due_on' },
      certificateNumber: { column: 'certificate_number' }, performedBy: { column: 'performed_by' }, supplier: { column: 'supplier_id' },
      technicianName: { column: 'imported_technician' }, notes: { column: 'notes' },
    },
    excluded: {
      ...SYSTEM,
      reference: 'Fortress gives every calibration its own reference',
      technician_id: 'A technician is a Fortress user; the source\'s name goes in the technician text',
      procedure_ref: 'A legacy record says what was concluded, not how',
      reference_standards: 'A legacy record says what was concluded, not how',
      temperature_c: 'A legacy record has no readings or conditions',
      humidity_pct: 'A legacy record has no readings or conditions',
      nonconformance_id: 'Linked from a failed calibration in Fortress',
      is_legacy: 'Set by the import itself: it is what marks the record as legacy',
      imported_from: 'Set by the import itself: the connection it came through',
      deleted_at: 'Deleting is a person\'s step with a reason',
      deleted_by: 'Deleting is a person\'s step with a reason',
      delete_reason: 'Deleting is a person\'s step with a reason',
    },
  },
  nonconformance: {
    table: 'nonconformances',
    fields: {
      title: { column: 'title' }, source: { column: 'source' }, category: { column: 'category_id' }, severity: { column: 'severity' },
      description: { column: 'description' }, requirement: { column: 'requirement' }, actualResult: { column: 'actual_result' }, detectedAt: { column: 'detected_at' },
      site: { column: 'site_id' }, part: { column: 'part_id' }, customer: { column: 'customer_id' }, supplier: { column: 'supplier_id' },
      detectionMachine: { column: 'detection_process_id' }, causalMachine: { column: 'causal_process_id' }, responsibleEmployee: { column: 'responsible_employee_id' },
      detectedBy: { column: 'detected_by_employee_id' }, responsibleDepartment: { column: 'responsible_department_id' },
      quantityAffected: { column: 'quantity_affected' }, quantityInspected: { column: 'quantity_inspected' }, workOrder: { column: 'work_order' },
      purchaseOrder: { column: 'purchase_order' }, customerReference: { column: 'customer_reference' }, lotNumber: { column: 'lot_number' },
      serialNumber: { column: 'serial_number' }, stage: { column: 'stage' }, closedOn: { column: 'closed_at' }, stageReason: { column: 'stage_reason' },
    },
    excluded: {
      ...SYSTEM,
      reference: 'Fortress numbers every non-conformance',
      closed_by: 'Closed by nobody in particular: a stage carried over from the source is history',
      deleted_at: 'Deleting is a person\'s step with a reason', deleted_by: 'Deleting is a person\'s step with a reason', delete_reason: 'Deleting is a person\'s step with a reason',
      detected_by: 'A Fortress user',
      owner_id: 'A Fortress user, chosen in Fortress',
      part_revision_id: 'Not imported yet: the part is linked, its revision is chosen in Fortress',
      failure_mode_id: 'Not imported yet: chosen in Fortress', sub_failure_mode_id: 'Not imported yet: chosen in Fortress',
      legacy_ncm_id: 'The old in-app NC register only',
      containment_not_needed_reason: 'Part of containment, done in Fortress',
      production_order_id: 'Not imported yet: production links are made in Fortress', lot_id: 'Not imported yet: production links are made in Fortress',
      serial_id: 'Not imported yet: production links are made in Fortress',
      source_change_reason: 'Changing the source is a person\'s step with a reason',
      client_key: 'Made by a screen so a retry cannot make a second record; an import has its own way of not repeating itself',
    },
  },
  ncr_cost: {
    table: 'ncr_costs',
    fields: {
      nonconformance: { column: 'nonconformance_id' }, costType: { column: 'cost_type' }, description: { column: 'description' }, incurredOn: { column: 'incurred_on' },
      currency: { column: 'currency' }, unitCost: { column: 'unit_cost' }, quantity: { column: 'quantity' }, vatTreatment: { column: 'vat_treatment' },
      // a percentage in the file, a fraction in the column: the column's own limits do not describe the file's value
      vatRate: { column: 'vat_rate', ownRules: true },
    },
    excluded: {
      ...SYSTEM,
      amount: 'Worked out by the database: quantity × unit cost',
      net_amount: 'Worked out by the database', vat_amount: 'Worked out by the database', gross_amount: 'Worked out by the database',
      base_currency: 'The currency of the non-conformance\'s site, fixed when the line is made', org_currency: 'The organisation\'s currency, fixed when the line is made',
      exchange_rate: 'Looked up for the line\'s own date, never typed; a booked value states it instead', org_rate: 'Looked up by the database',
      net_base: 'Worked out by the database', gross_base: 'Worked out by the database', net_org: 'Worked out by the database', gross_org: 'Worked out by the database',
      cost_sign: 'Set by the cost type: a recovery or a charge is a credit',
      rate_status: 'Worked out by the database', rate_source: 'Worked out by the database', rate_date: 'Worked out by the database',
      rate_fetched_at: 'Worked out by the database', estimated_rate: 'Kept by the database when a booked value is stated',
      override_kind: 'Set when a booked value is applied', override_note: 'Set when a booked value is applied',
      overridden_at: 'Set when a booked value is applied', overridden_by: 'Set when a booked value is applied',
      deleted_at: 'Deleting is a person\'s step with a reason', deleted_by: 'Deleting is a person\'s step with a reason', delete_reason: 'Deleting is a person\'s step with a reason',
      client_key: 'Made by a screen so a retry cannot make a second line; an import has its own way of not repeating itself',
    },
    virtual: { bookedValue: 'The value the source booked in the site currency: applied as a stated rate on the line, not stored as a column of its own' },
  },
  purchase_order: {
    table: 'purchase_order_lines',
    fields: {
      poNumber: { column: 'po_number', table: 'purchase_orders' }, supplier: { column: 'supplier_id', table: 'purchase_orders' },
      orderedOn: { column: 'ordered_on', table: 'purchase_orders' }, orderNotes: { column: 'notes', table: 'purchase_orders' },
      lineNumber: { column: 'line_number' }, part: { column: 'part_id' }, material: { column: 'material' }, quantityOrdered: { column: 'quantity_ordered' },
      unit: { column: 'unit' }, requestedOn: { column: 'requested_on' }, agreedOn: { column: 'agreed_on' }, lineStatus: { column: 'status' },
    },
    excluded: {
      ...SYSTEM,
      purchase_order_id: 'The order is found by its number, or made from the line',
    },
    virtual: {
      quantityReceived: 'The source\'s received total, kept in integration_po_line_totals for the received quantities check',
      lastReceivedOn: 'The source\'s last received date, kept with the total',
    },
  },
  po_receipt_total: {
    table: 'integration_po_line_totals',
    fields: {
      poNumber: { column: 'po_line_id' }, poLine: { column: 'po_line_id' }, quantityReceived: { column: 'quantity_received' },
      deliveryNote: { column: 'delivery_note', table: 'goods_receipts' },
    },
    excluded: {
      id: 'Fortress assigns the id',
      organisation_id: 'The organisation of the connection',
      connection_id: 'The connection the total came through',
      run_id: 'The import that last reported it',
      created_at: 'Set by the database',
      updated_at: 'Set by the database',
      last_received_on: 'Written with the total, from Last received on',
    },
    virtual: {
      lastReceivedOn: 'Kept with the total (last_received_on) and dates the delivery of the difference',
    },
  },
  goods_receipt: {
    table: 'goods_receipt_lines',
    fields: {
      documentNumber: { column: 'source_document', table: 'goods_receipts' }, supplier: { column: 'supplier_id', table: 'goods_receipts' },
      poNumber: { column: 'purchase_order_id', table: 'goods_receipts' }, receivedOn: { column: 'received_on', table: 'goods_receipts' },
      deliveryNote: { column: 'delivery_note', table: 'goods_receipts' }, site: { column: 'site_id', table: 'goods_receipts' },
      poLine: { column: 'po_line_id' }, part: { column: 'part_id' }, material: { column: 'material' }, quantity: { column: 'quantity_received', ownRules: true },
      lotNumber: { column: 'lot_id' }, notes: { column: 'notes' },
    },
    excluded: {
      ...SYSTEM,
      goods_receipt_id: 'The receipt is found by its document, or made from the row',
      line_number: 'Numbered in Fortress, in the order the rows arrive',
    },
    virtual: {
      movement: 'Says whether the row is a delivery or a return (a return becomes a rejection decision, never a line)',
      leaveOut: 'Rows marked are skipped before anything is written',
    },
  },
  customer_order: {
    table: 'customer_order_lines',
    fields: {
      orderNumber: { column: 'order_number', table: 'customer_orders' }, customer: { column: 'customer_id', table: 'customer_orders' },
      customerReference: { column: 'customer_reference', table: 'customer_orders' },
      orderedOn: { column: 'ordered_on', table: 'customer_orders' }, orderNotes: { column: 'notes', table: 'customer_orders' },
      lineNumber: { column: 'line_number' }, part: { column: 'part_id' }, quantityOrdered: { column: 'quantity_ordered' },
      unit: { column: 'unit' }, requestedOn: { column: 'requested_on' }, agreedOn: { column: 'agreed_on' }, lineStatus: { column: 'status' },
    },
    excluded: {
      ...SYSTEM,
      customer_order_id: 'The order is found by its number, or made from the line',
    },
  },
  shipment: {
    table: 'shipment_lines',
    fields: {
      documentNumber: { column: 'source_document', table: 'shipments' }, customer: { column: 'customer_id', table: 'shipments' },
      orderNumber: { column: 'customer_order_id', table: 'shipments' }, shippedOn: { column: 'shipped_on', table: 'shipments' },
      deliveryNote: { column: 'delivery_note', table: 'shipments' }, site: { column: 'site_id', table: 'shipments' },
      orderLine: { column: 'order_line_id' }, part: { column: 'part_id' }, quantity: { column: 'quantity_shipped' }, lotNumber: { column: 'lot_id' }, notes: { column: 'notes' },
    },
    excluded: {
      ...SYSTEM,
      shipment_id: 'The shipment is found by its document, or made from the row',
      line_number: 'Numbered in Fortress, in the order the rows arrive',
    },
    virtual: {
      movement: 'Says whether the row is a shipment or a return (a return is refused: it belongs to an RMA, never to a shipment)',
      leaveOut: 'Rows marked are skipped before anything is written',
    },
  },
  production_order: {
    table: 'production_orders',
    fields: {
      orderNumber: { column: 'order_number' }, part: { column: 'part_id' }, partRevision: { column: 'part_revision_id' }, customer: { column: 'customer_id' },
      site: { column: 'site_id' }, quantityPlanned: { column: 'quantity_planned' }, dueDate: { column: 'due_date' }, status: { column: 'status' },
      statusReason: { column: 'status_reason' }, notes: { column: 'notes' },
    },
    excluded: {
      ...SYSTEM,
      external_system: 'Filled by the import from the connection\'s system code',
      external_id: 'Filled by the import from the key column',
    },
  },
};
