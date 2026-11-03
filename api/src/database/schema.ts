/**
 * Drizzle definitions for the tables the API reads/writes directly. The SQL migrations in
 * supabase/migrations are the source of truth; keep these in step with them.
 */
import { boolean, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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

export const schema = { profiles, organisations, organisationSettings, organisationUsers, sites, departments };
