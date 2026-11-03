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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const organisationSettings = pgTable('organisation_settings', {
  organisationId: uuid('organisation_id').primaryKey(),
  baseCurrency: text('base_currency').notNull(),
  vatRate: numeric('vat_rate').notNull(),
  ncrReferencePrefix: text('ncr_reference_prefix').notNull(),
  themeColour: text('theme_colour').notNull(),
  requireMfa: boolean('require_mfa').notNull(),
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
  customerId: uuid('customer_id'),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const schema = { profiles, organisations, organisationSettings, organisationUsers, sites, departments, units, customers, suppliers, parts, partRevisions };
