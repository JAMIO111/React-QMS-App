import { z } from 'zod';

/** Optional text that is trimmed; empty means "clear it". */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const csv = (values: readonly string[]) =>
  z
    .string()
    .optional()
    .refine((v) => !v || v.split(',').every((x) => values.includes(x)), `One or more of ${values.join(', ')}`);

/** The 18 elements, in order (a mirror of app.ppap_element_types(); ppap.e2e-spec.ts fails when they differ). Plain wording, not the manual's text. */
export const ELEMENT_TYPES = [
  { key: 'design_records', label: 'Design records' },
  { key: 'engineering_change_documents', label: 'Engineering change documents' },
  { key: 'customer_engineering_approval', label: 'Customer engineering approval' },
  { key: 'dfmea', label: 'Design FMEA' },
  { key: 'process_flow_diagram', label: 'Process flow diagram' },
  { key: 'pfmea', label: 'Process FMEA' },
  { key: 'control_plan', label: 'Control plan' },
  { key: 'msa_studies', label: 'Measurement system studies' },
  { key: 'dimensional_results', label: 'Dimensional results' },
  { key: 'material_performance_tests', label: 'Material and performance test results' },
  { key: 'initial_process_studies', label: 'Initial process studies' },
  { key: 'laboratory_documentation', label: 'Qualified laboratory documentation' },
  { key: 'appearance_approval_report', label: 'Appearance approval report' },
  { key: 'sample_production_parts', label: 'Sample production parts' },
  { key: 'master_sample', label: 'Master sample' },
  { key: 'checking_aids', label: 'Checking aids' },
  { key: 'customer_specific_requirements', label: 'Customer-specific requirements' },
  { key: 'part_submission_warrant', label: 'Part Submission Warrant' },
] as const;
export const ELEMENT_KEYS = ELEMENT_TYPES.map((e) => e.key) as unknown as readonly [string, ...string[]];
export const ELEMENT_LABEL: Record<string, string> = Object.fromEntries(ELEMENT_TYPES.map((e) => [e.key, e.label]));
export const ELEMENT_ORDINAL: Record<string, number> = Object.fromEntries(ELEMENT_TYPES.map((e, i) => [e.key, i + 1]));

export const PPAP_STATUSES = ['draft', 'in_preparation', 'ready', 'submitted', 'approved', 'interim_approved', 'rejected', 'withdrawn'] as const;
export const PPAP_REASONS = [
  'new_part', 'engineering_change', 'tooling', 'discrepancy_correction', 'alternate_material_or_supplier', 'process_change', 'not_produced_12_months', 'customer_request', 'other',
] as const;
export const REQUIREMENTS = ['required', 'retain', 'not_required', 'n_a'] as const;
export const ELEMENT_STATUSES = ['not_started', 'in_progress', 'ready'] as const;
export const LEVELS = [1, 2, 3, 4, 5] as const;

export const CreatePpapBody = z
  .object({
    partId: z.string().uuid(),
    partRevisionId: z.string().uuid().optional(),
    customerId: z.string().uuid(),
    siteId: z.string().uuid().nullable().optional(),
    level: z.number().int().min(1).max(5).optional(),
    reason: z.enum(PPAP_REASONS),
    notes: text(2000),
    ownerId: z.string().uuid().optional(),
    clientKey: z.string().min(8).max(80).optional(),
  })
  .strict();
export type CreatePpapBody = z.infer<typeof CreatePpapBody>;

export const UpdatePpapBody = z
  .object({
    siteId: z.string().uuid().nullable().optional(),
    reason: z.enum(PPAP_REASONS).optional(),
    notes: text(2000),
    ownerId: z.string().uuid().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export type UpdatePpapBody = z.infer<typeof UpdatePpapBody>;

export const LevelBody = z.object({ level: z.number().int().min(1).max(5) }).strict();
export const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export const WaiveBody = z.object({ reason: z.string().trim().min(10).max(1000) }).strict();

export const UpdateElementBody = z
  .object({
    requirement: z.enum(REQUIREMENTS).optional(),
    status: z.enum(ELEMENT_STATUSES).optional(),
    note: text(2000),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export type UpdateElementBody = z.infer<typeof UpdateElementBody>;

/** A file already uploaded to the submission's own folder in the ppap-files bucket. */
export const AddFileBody = z
  .object({
    storagePath: z.string().min(1).max(500),
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().max(200).nullable().optional(),
    sizeBytes: z.number().int().min(0).max(26214400),
    description: text(500),
  })
  .strict();
export type AddFileBody = z.infer<typeof AddFileBody>;

export const PpapListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  /** Statuses separated by commas, `live` (default: not withdrawn or rejected), or `all`. */
  status: csv([...PPAP_STATUSES, 'live', 'all']),
  direction: csv(['submitted', 'received']),
  level: csv(['1', '2', '3', '4', '5']),
  reason: csv(PPAP_REASONS),
  owner: z.enum(['me']).optional(),
  customerId: z.string().uuid().optional(),
  partId: z.string().uuid().optional(),
  sort: z.enum(['reference', 'part', 'customer', 'level', 'status', 'owner', 'progress', 'updatedAt', 'createdAt']).default('reference'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type PpapListQuery = z.infer<typeof PpapListQuery>;

// ---- the requirements ------------------------------------------------------------------------------------
const cell = z.enum(['submit', 'retain', 'none']);
const levelRow = z.object({ '1': cell, '2': cell, '3': cell, '4': cell, '5': cell }).strict();
/** The organisation's matrix and minimums; the database says whether it is complete (a row for every element). */
export const RequirementConfig = z
  .object({
    rows: z.record(z.string(), levelRow),
    minCpkInitial: z.number().min(0.1).max(10),
    minCpkOngoing: z.number().min(0.1).max(10),
    minReadings: z.number().int().min(1).max(10000),
    maxGrrPercent: z.number().min(1).max(100),
    defaultLevel: z.number().int().min(1).max(5),
  })
  .strict();
export type RequirementConfig = z.infer<typeof RequirementConfig>;
export const SaveRequirementsBody = z.object({ config: RequirementConfig, reason: z.string().trim().min(3).max(1000) }).strict();
export type SaveRequirementsBody = z.infer<typeof SaveRequirementsBody>;

const optionalNumber = (min: number, max: number) => z.number().min(min).max(max).nullable().optional();
export const CustomerRulesBody = z
  .object({
    defaultLevel: z.number().int().min(1).max(5).nullable().optional(),
    extraElements: z.array(z.enum(ELEMENT_KEYS)).max(18).optional(),
    minCpkInitial: optionalNumber(0.1, 10),
    minCpkOngoing: optionalNumber(0.1, 10),
    minReadings: z.number().int().min(1).max(10000).nullable().optional(),
    maxGrrPercent: optionalNumber(1, 100),
    note: text(1000),
  })
  .strict();
export type CustomerRulesBody = z.infer<typeof CustomerRulesBody>;
