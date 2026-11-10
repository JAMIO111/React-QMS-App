/**
 * Drizzle definitions for the tables the API reads/writes directly. The SQL migrations in
 * supabase/migrations are the source of truth; keep these in step with them.
 */
import { boolean, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  firstName: text('first_name'),
  surname: text('surname'),
  jobTitle: text('job_title'),
  avatarPath: text('avatar_path'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const organisations = pgTable('organisations', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  status: text('status').notNull(),
  legalName: text('legal_name'),
  country: text('country'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const organisationSettings = pgTable('organisation_settings', {
  organisationId: uuid('organisation_id').primaryKey(),
  baseCurrency: text('base_currency').notNull(),
  vatRate: numeric('vat_rate').notNull(),
  ncrReferencePrefix: text('ncr_reference_prefix').notNull(),
  themeColour: text('theme_colour').notNull(),
  requireMfa: boolean('require_mfa').notNull(),
  logoPath: text('logo_path'),
  useLotsAndSerials: boolean('use_lots_and_serials').notNull(),
  allowInlineOrders: boolean('allow_inline_orders').notNull(),
  requireProductionOrder: boolean('require_production_order').notNull(),
  advancedImports: boolean('advanced_imports').notNull(),
});

export const organisationUsers = pgTable('organisation_users', {
  id: uuid('id').primaryKey(),
  organisationId: uuid('organisation_id').notNull(),
  userId: uuid('user_id'),
  status: text('status').notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }),
});

export const sites = pgTable('sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: uuid('organisation_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('Europe/London'),
  /** Default currency for money entered at this site; a new site starts with the organisation's (set by a database trigger when omitted). */
  currency: text('currency').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const departments = pgTable('departments', {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: uuid('organisation_id').notNull(),
  siteId: uuid('site_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Phase 2 master data (supabase/migrations/20251104120000_master_data.sql)
export const units = pgTable('units', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  quantityKind: text('quantity_kind').notNull(),
  sortOrder: integer('sort_order').notNull(),
});

const partyColumns = {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: uuid('organisation_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  displayName: text('display_name'),
  companyNumber: text('company_number'),
  vatNumber: text('vat_number'),
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};
export const customers = pgTable('customers', { ...partyColumns });
export const suppliers = pgTable('suppliers', { ...partyColumns });

export const parts = pgTable('parts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: uuid('organisation_id').notNull(),
  partNumber: text('part_number').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  partFamilyId: uuid('part_family_id'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const partRevisions = pgTable('part_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: uuid('organisation_id').notNull(),
  partId: uuid('part_id').notNull(),
  revision: text('revision').notNull(),
  drawingRef: text('drawing_ref'),
  changeSummary: text('change_summary'),
  status: text('status').notNull().default('draft'),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releasedBy: uuid('released_by'),
  /** A correction keeps the drawing's letter and counts up the version (supabase/migrations/20251208100000_part_revision_corrections.sql). */
  version: integer('version').notNull().default(1),
  correctsId: uuid('corrects_id'),
  correctionReason: text('correction_reason'),
  correctedAt: timestamp('corrected_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Phase 2 NCR core (supabase/migrations/20251104130000_ncr_core.sql)
export const ncrClassifications = pgTable('ncr_classifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: uuid('organisation_id').notNull(),
  kind: text('kind').notNull(),
  parentId: uuid('parent_id'),
  code: text('code'),
  name: text('name').notNull(),
  description: text('description'),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const nonconformances = pgTable('nonconformances', {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: uuid('organisation_id').notNull(),
  reference: text('reference').notNull().default(''),
  source: text('source').notNull(),
  categoryId: uuid('category_id'),
  sourceChangeReason: text('source_change_reason'),
  stage: text('stage').notNull().default('draft'),
  stageReason: text('stage_reason'),
  severity: text('severity'),
  title: text('title').notNull(),
  description: text('description'),
  requirement: text('requirement'),
  actualResult: text('actual_result'),
  siteId: uuid('site_id'),
  partId: uuid('part_id'),
  partRevisionId: uuid('part_revision_id'),
  customerId: uuid('customer_id'),
  supplierId: uuid('supplier_id'),
  workOrder: text('work_order'),
  purchaseOrder: text('purchase_order'),
  customerReference: text('customer_reference'),
  lotNumber: text('lot_number'),
  serialNumber: text('serial_number'),
  productionOrderId: uuid('production_order_id'),
  lotId: uuid('lot_id'),
  serialId: uuid('serial_id'),
  quantityAffected: numeric('quantity_affected'),
  quantityInspected: numeric('quantity_inspected'),
  detectedAt: text('detected_at'),
  detectedBy: uuid('detected_by'),
  detectionProcessId: uuid('detection_process_id'),
  causalProcessId: uuid('causal_process_id'),
  failureModeId: uuid('failure_mode_id'),
  subFailureModeId: uuid('sub_failure_mode_id'),
  responsibleEmployeeId: uuid('responsible_employee_id'),
  ownerId: uuid('owner_id'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deleteReason: text('delete_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const schema = { profiles, organisations, organisationSettings, organisationUsers, sites, departments, units, customers, suppliers, parts, partRevisions, ncrClassifications, nonconformances };
