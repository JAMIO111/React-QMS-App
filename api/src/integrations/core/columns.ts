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
}
export interface EntityColumns {
  table: string;
  /** Catalogue field key → the column it fills. */
  fields: Record<string, FieldColumn>;
  /** Columns never imported, with why. */
  excluded: Record<string, string>;
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
      addressLine2: { column: 'address_line2' }, city: { column: 'city' }, region: { column: 'region' }, postcode: { column: 'postcode' },
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
      vatNumber: { column: 'vat_number' }, notes: { column: 'notes' }, active: { column: 'active' },
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
    excluded: { ...SYSTEM },
  },
  gauge: {
    table: 'gauges',
    fields: {
      assetNumber: { column: 'asset_number' }, description: { column: 'description' }, gaugeType: { column: 'gauge_type_id' }, manufacturer: { column: 'manufacturer' },
      model: { column: 'model' }, serialNumber: { column: 'serial_number' }, site: { column: 'site_id' }, department: { column: 'department_id' },
      location: { column: 'location' }, rangeMin: { column: 'range_min' }, rangeMax: { column: 'range_max' }, unit: { column: 'unit_code' },
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
  nonconformance: {
    table: 'nonconformances',
    fields: {
      title: { column: 'title' }, source: { column: 'source' }, category: { column: 'category_id' }, severity: { column: 'severity' },
      description: { column: 'description' }, requirement: { column: 'requirement' }, actualResult: { column: 'actual_result' }, detectedAt: { column: 'detected_at' },
      site: { column: 'site_id' }, part: { column: 'part_id' }, customer: { column: 'customer_id' }, supplier: { column: 'supplier_id' },
      detectionMachine: { column: 'detection_process_id' }, causalMachine: { column: 'causal_process_id' }, responsibleEmployee: { column: 'responsible_employee_id' },
      quantityAffected: { column: 'quantity_affected' }, quantityInspected: { column: 'quantity_inspected' }, workOrder: { column: 'work_order' },
      purchaseOrder: { column: 'purchase_order' }, customerReference: { column: 'customer_reference' }, lotNumber: { column: 'lot_number' },
      serialNumber: { column: 'serial_number' },
    },
    excluded: {
      ...SYSTEM,
      reference: 'Fortress numbers every non-conformance',
      stage: 'Always arrives as a draft; moving stages is a person\'s step',
      stage_reason: 'Part of moving stages',
      closed_at: 'Closing is a person\'s step', closed_by: 'Closing is a person\'s step',
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
    },
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
