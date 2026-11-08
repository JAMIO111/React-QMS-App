import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date as YYYY-MM-DD');
const Ref = z.object({ id: z.string().uuid(), code: z.string(), name: z.string() });
const PartRef = z.object({ id: z.string().uuid(), partNumber: z.string(), name: z.string() });
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const id = z.string().uuid().nullable().optional();
const number60 = z.string().trim().min(1).max(60);
const positive = z.coerce.number().positive().max(1e9);

const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : []))
    .pipe(z.array(item).max(10));

export const ORDER_STATUSES = ['planned', 'released', 'in_progress', 'completed', 'closed', 'cancelled'] as const;
export const OPERATION_STATUSES = ['pending', 'in_progress', 'completed', 'skipped'] as const;
export const LOT_STATUSES = ['open', 'on_hold', 'released', 'closed'] as const;
export const SERIAL_STATUSES = ['in_production', 'completed', 'scrapped'] as const;

const page = {
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
};
const pageOf = <T extends z.ZodTypeAny>(item: T) => z.object({ data: z.array(item), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });

// ---------------------------------------------------------------------------------------------------------------------------------- Orders
export const ORDER_SORTABLE = ['orderNumber', 'part', 'customer', 'quantityPlanned', 'dueDate', 'status', 'createdAt'] as const;
export const OrderListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: csv(z.enum(ORDER_STATUSES)),
  partId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  sort: z.enum(ORDER_SORTABLE).default('createdAt'),
  ...page,
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type OrderListQuery = z.infer<typeof OrderListQuery>;

export const Operation = z.object({
  id: z.string().uuid(),
  sequence: z.number().int(),
  operationCode: z.string(),
  description: z.string().nullable(),
  machine: Ref.nullable(),
  status: z.enum(OPERATION_STATUSES),
});

export const ProductionOrder = z.object({
  id: z.string().uuid(),
  orderNumber: z.string(),
  part: PartRef,
  partRevision: z.object({ id: z.string().uuid(), revision: z.string(), version: z.number().int() }).nullable(),
  customer: Ref.nullable(),
  site: Ref.nullable(),
  quantityPlanned: z.number(),
  dueDate: DateOnly.nullable(),
  status: z.enum(ORDER_STATUSES),
  statusReason: z.string().nullable(),
  notes: z.string().nullable(),
  /** Set when the order was imported from another system (never by people). */
  external: z.object({ system: z.string(), id: z.string() }).nullable(),
  lotCount: z.number().int(),
  serialCount: z.number().int(),
  operationCount: z.number().int(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type ProductionOrder = z.infer<typeof ProductionOrder>;
export const ProductionOrderDetail = ProductionOrder.extend({ operations: z.array(Operation) });
export type ProductionOrderDetail = z.infer<typeof ProductionOrderDetail>;
export const OrderPage = pageOf(ProductionOrder);

export const CreateOrderBody = z
  .object({ orderNumber: number60, partId: z.string().uuid(), partRevisionId: id, customerId: id, siteId: id, quantityPlanned: positive, dueDate: DateOnly.nullable().optional(), notes: text(2000) })
  .strict();
export type CreateOrderBody = z.infer<typeof CreateOrderBody>;

export const UpdateOrderBody = z
  .object({ partRevisionId: id, customerId: id, quantityPlanned: positive.optional(), dueDate: DateOnly.nullable().optional(), notes: text(2000), status: z.enum(ORDER_STATUSES).optional(), statusReason: text(1000) })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export type UpdateOrderBody = z.infer<typeof UpdateOrderBody>;

export const CreateOperationBody = z
  .object({ sequence: z.coerce.number().int().min(1).max(9999).optional(), operationCode: z.string().trim().min(1).max(40), description: text(200), machineId: id })
  .strict();
export type CreateOperationBody = z.infer<typeof CreateOperationBody>;
export const UpdateOperationBody = z
  .object({ sequence: z.coerce.number().int().min(1).max(9999).optional(), operationCode: z.string().trim().min(1).max(40).optional(), description: text(200), machineId: id, status: z.enum(OPERATION_STATUSES).optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export type UpdateOperationBody = z.infer<typeof UpdateOperationBody>;

// ---------------------------------------------------------------------------------------------------------------------------------- Lots
export const LOT_SORTABLE = ['lotNumber', 'part', 'origin', 'quantity', 'status', 'createdAt'] as const;
export const LotListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: csv(z.enum(LOT_STATUSES)),
  origin: z.enum(['produced', 'received']).optional(),
  partId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  productionOrderId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  sort: z.enum(LOT_SORTABLE).default('createdAt'),
  ...page,
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type LotListQuery = z.infer<typeof LotListQuery>;

export const Lot = z.object({
  id: z.string().uuid(),
  lotNumber: z.string(),
  part: PartRef,
  origin: z.enum(['produced', 'received']),
  productionOrder: z.object({ id: z.string().uuid(), orderNumber: z.string() }).nullable(),
  supplier: Ref.nullable(),
  site: Ref.nullable(),
  quantity: z.number().nullable(),
  receivedOn: DateOnly.nullable(),
  status: z.enum(LOT_STATUSES),
  statusReason: z.string().nullable(),
  notes: z.string().nullable(),
  serialCount: z.number().int(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Lot = z.infer<typeof Lot>;
export const LotPage = pageOf(Lot);

export const CreateLotBody = z
  .object({
    lotNumber: number60,
    partId: z.string().uuid(),
    origin: z.enum(['produced', 'received']),
    productionOrderId: id,
    supplierId: id,
    siteId: id,
    quantity: positive.nullable().optional(),
    receivedOn: DateOnly.nullable().optional(),
    notes: text(2000),
  })
  .strict();
export type CreateLotBody = z.infer<typeof CreateLotBody>;

export const UpdateLotBody = z
  .object({ supplierId: id, quantity: positive.nullable().optional(), receivedOn: DateOnly.nullable().optional(), notes: text(2000), status: z.enum(LOT_STATUSES).optional(), statusReason: text(1000) })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export type UpdateLotBody = z.infer<typeof UpdateLotBody>;

// ---------------------------------------------------------------------------------------------------------------------------------- Serial numbers
export const SERIAL_SORTABLE = ['serialNumber', 'part', 'lot', 'status', 'createdAt'] as const;
export const SerialListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: csv(z.enum(SERIAL_STATUSES)),
  partId: z.string().uuid().optional(),
  lotId: z.string().uuid().optional(),
  productionOrderId: z.string().uuid().optional(),
  sort: z.enum(SERIAL_SORTABLE).default('createdAt'),
  ...page,
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type SerialListQuery = z.infer<typeof SerialListQuery>;

export const Serial = z.object({
  id: z.string().uuid(),
  serialNumber: z.string(),
  part: PartRef,
  lot: z.object({ id: z.string().uuid(), lotNumber: z.string() }).nullable(),
  productionOrder: z.object({ id: z.string().uuid(), orderNumber: z.string() }).nullable(),
  site: Ref.nullable(),
  status: z.enum(SERIAL_STATUSES),
  statusReason: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Serial = z.infer<typeof Serial>;
export const SerialPage = pageOf(Serial);

/** Most serial numbers one request may create (all or nothing). */
export const MAX_SERIAL_BATCH = 500;
const SerialRange = z
  .object({ prefix: z.string().trim().max(40).default(''), from: z.coerce.number().int().min(0).max(999999999), to: z.coerce.number().int().min(0).max(999999999), pad: z.coerce.number().int().min(0).max(12).default(0) })
  .strict()
  .refine((r) => r.to >= r.from, { message: '"to" must not be below "from"' })
  .refine((r) => r.to - r.from + 1 <= MAX_SERIAL_BATCH, { message: `At most ${MAX_SERIAL_BATCH} serial numbers at once` });

/** Create one serial number, a list of them, or a numbered range ("SN-0001" … "SN-0050"). Exactly one of serialNumber, serials, range. */
export const CreateSerialsBody = z
  .object({
    partId: z.string().uuid(),
    lotId: id,
    productionOrderId: id,
    siteId: id,
    notes: text(2000),
    serialNumber: number60.optional(),
    serials: z.array(number60).min(1).max(MAX_SERIAL_BATCH).optional(),
    range: SerialRange.optional(),
  })
  .strict()
  .refine((b) => [b.serialNumber, b.serials, b.range].filter((x) => x !== undefined).length === 1, { message: 'Give exactly one of serialNumber, serials or range' });
export type CreateSerialsBody = z.infer<typeof CreateSerialsBody>;

export const UpdateSerialBody = z
  .object({ lotId: id, productionOrderId: id, notes: text(2000), status: z.enum(SERIAL_STATUSES).optional(), statusReason: text(1000) })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export type UpdateSerialBody = z.infer<typeof UpdateSerialBody>;

// ---------------------------------------------------------------------------------------------------------------------------------- Pickers
const LookupBase = z.object({ q: z.string().trim().max(100).optional(), partId: z.string().uuid().optional(), includeClosed: z.enum(['true', 'false']).optional().transform((v) => v === 'true') });
export const OrderLookupQuery = LookupBase;
export const LotLookupQuery = LookupBase.extend({ productionOrderId: z.string().uuid().optional() });
export const SerialLookupQuery = LookupBase.extend({ lotId: z.string().uuid().optional(), productionOrderId: z.string().uuid().optional() });

export const OrderOption = z.object({ id: z.string().uuid(), orderNumber: z.string(), part: PartRef, status: z.enum(ORDER_STATUSES), quantityPlanned: z.number() });
export const LotOption = z.object({
  id: z.string().uuid(),
  lotNumber: z.string(),
  part: PartRef,
  origin: z.enum(['produced', 'received']),
  productionOrder: z.object({ id: z.string().uuid(), orderNumber: z.string() }).nullable(),
  status: z.enum(LOT_STATUSES),
  statusReason: z.string().nullable(),
});
export const SerialOption = z.object({
  id: z.string().uuid(),
  serialNumber: z.string(),
  part: PartRef,
  lot: z.object({ id: z.string().uuid(), lotNumber: z.string() }).nullable(),
  productionOrder: z.object({ id: z.string().uuid(), orderNumber: z.string() }).nullable(),
  status: z.enum(SERIAL_STATUSES),
});
