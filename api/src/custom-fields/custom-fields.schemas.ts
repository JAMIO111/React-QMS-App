import { z } from 'zod';

/** The kinds of record that take custom fields (app.custom_field_entities()). */
export const CUSTOM_FIELD_ENTITIES = [
  'part', 'part_family', 'machine', 'gauge_type', 'gauge', 'supplier', 'customer', 'employee',
  'nonconformance', 'capa', 'inspection', 'production_order', 'lot',
] as const;
export const CustomFieldEntity = z.enum(CUSTOM_FIELD_ENTITIES);
export type CustomFieldEntity = z.infer<typeof CustomFieldEntity>;

export const CUSTOM_FIELD_ENTITY_LABELS: Record<CustomFieldEntity, string> = {
  part: 'Parts',
  part_family: 'Part families',
  machine: 'Machines',
  gauge_type: 'Gauge types',
  gauge: 'Gauges',
  supplier: 'Suppliers',
  customer: 'Customers',
  employee: 'Employees',
  nonconformance: 'Non-conformances',
  capa: '8Ds',
  inspection: 'Inspections',
  production_order: 'Production orders',
  lot: 'Lots',
};

/** The stages a field can be required at, in order (app.custom_field_stages). */
export const CUSTOM_FIELD_STAGES: Partial<Record<CustomFieldEntity, { value: string; label: string }[]>> = {
  nonconformance: [
    { value: 'draft', label: 'Draft' }, { value: 'open', label: 'Open' }, { value: 'contained', label: 'Contained' },
    { value: 'investigating', label: 'Investigating' }, { value: 'dispositioned', label: 'Dispositioned' },
    { value: 'awaiting_closure', label: 'Awaiting closure' }, { value: 'closed', label: 'Closed' },
  ],
  capa: [
    { value: 'open', label: 'Open' }, { value: 'actions_in_progress', label: 'Actions in progress' },
    { value: 'awaiting_verification', label: 'Awaiting verification' }, { value: 'verified_effective', label: 'Verified effective' },
    { value: 'closed', label: 'Closed' },
  ],
  inspection: [{ value: 'in_progress', label: 'In progress' }, { value: 'completed', label: 'Completed' }],
  production_order: [
    { value: 'planned', label: 'Planned' }, { value: 'released', label: 'Released' }, { value: 'in_progress', label: 'In progress' },
    { value: 'completed', label: 'Completed' }, { value: 'closed', label: 'Closed' },
  ],
  lot: [{ value: 'open', label: 'Open' }, { value: 'released', label: 'Released' }, { value: 'closed', label: 'Closed' }],
};

export const CUSTOM_FIELD_TYPES = ['text', 'long_text', 'number', 'date', 'boolean', 'choice', 'multi_choice', 'person'] as const;
export const CustomFieldType = z.enum(CUSTOM_FIELD_TYPES);
export const CUSTOM_FIELD_LIMIT = 20;
export const CUSTOM_FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;

export const CustomFieldOption = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_]{0,39}$/, 'An option key is lower case letters, digits and _'),
  label: z.string().trim().min(1, 'Give the option a label').max(80),
  active: z.boolean().default(true),
});

const FieldBody = {
  label: z.string().trim().min(1, 'Give the field a label').max(80, 'A label is at most 80 characters'),
  helpText: z.string().trim().max(500).nullable().optional(),
  section: z.string().trim().max(60).nullable().optional(),
  requiredAt: z.string().max(40).optional(),
  options: z.array(CustomFieldOption).max(100, 'At most 100 options').optional(),
  decimals: z.number().int().min(0).max(6).nullable().optional(),
  unit: z.string().trim().max(20).nullable().optional(),
  min: z.number().finite().nullable().optional(),
  max: z.number().finite().nullable().optional(),
};

export const CreateCustomFieldBody = z
  .object({ entityType: CustomFieldEntity, fieldType: CustomFieldType, key: z.string().regex(CUSTOM_FIELD_KEY, 'A key is lower case letters, digits and _, starting with a letter').optional(), ...FieldBody })
  .strict();
export type CreateCustomFieldBody = z.infer<typeof CreateCustomFieldBody>;
/** Changing a field: everything but its kind of record, key and type (which never change). */
export const UpdateCustomFieldBody = z.object(FieldBody).strict();
export type UpdateCustomFieldBody = z.infer<typeof UpdateCustomFieldBody>;
export const RetireCustomFieldBody = z.object({ reason: z.string().trim().min(3, 'Say why the field is retired').max(1000) }).strict();
export const ReorderCustomFieldsBody = z.object({ entityType: CustomFieldEntity, ids: z.array(z.string().uuid()).max(500) }).strict();

const bool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
export const CustomFieldsQuery = z.object({ entityType: CustomFieldEntity.optional(), includeRetired: bool.optional() });

export const CustomFieldDefinition = z.object({
  id: z.string().uuid(),
  entityType: CustomFieldEntity,
  key: z.string(),
  label: z.string(),
  fieldType: CustomFieldType,
  helpText: z.string().nullable(),
  section: z.string().nullable(),
  position: z.number().int(),
  requiredAt: z.string(),
  options: z.array(z.object({ key: z.string(), label: z.string(), active: z.boolean() })),
  decimals: z.number().int().nullable(),
  unit: z.string().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  active: z.boolean(),
  retiredAt: z.string().nullable(),
  retireReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CustomFieldDefinition = z.infer<typeof CustomFieldDefinition>;

export const CustomFieldList = z.object({
  data: z.array(CustomFieldDefinition),
  limit: z.number().int(),
  entities: z.array(z.object({
    entityType: CustomFieldEntity,
    label: z.string(),
    stages: z.array(z.object({ value: z.string(), label: z.string() })),
    activeCount: z.number().int(),
  })),
});

/** Values as sent by a person: field key → value; null, "" or [] clears one. Checked by the database against the definitions. */
export const CustomValuesInput = z
  .record(z.string().regex(CUSTOM_FIELD_KEY, 'Not a custom field key'), z.unknown())
  .refine((v) => Object.keys(v).length <= 40, 'Too many custom values');
export type CustomValuesInput = z.infer<typeof CustomValuesInput>;
/** What records carry: field key → stored value. */
export const CustomValues = z.record(z.string(), z.unknown());
export type CustomValues = Record<string, unknown>;

export const CustomValuesQuery = z.object({ entityType: CustomFieldEntity });
export const CustomValuesBatchQuery = z.object({
  entityType: CustomFieldEntity,
  ids: z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.string().uuid()).max(500)),
});
export const SetCustomValuesBody = z.object({ entityType: CustomFieldEntity, values: CustomValuesInput }).strict();
export const CustomValuesResponse = z.object({ entityType: CustomFieldEntity, recordId: z.string().uuid(), values: CustomValues });

/** For routes that create a record without a body of their own (e.g. raise an NC from a calibration): the new record's custom values. */
export const CustomValuesOnlyBody = z.object({ customValues: CustomValuesInput.optional() }).strict();
