import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30');
const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();
const text = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(1000);

export const ORDER_STATUSES = ['open', 'closed', 'cancelled'] as const;
export const ORDER_SORTS = ['orderNumber', 'customer', 'orderedOn', 'status', 'lines', 'nextDue'] as const;
export const SHIPMENT_SORTS = ['reference', 'customer', 'shippedOn', 'customerOrder', 'createdAt'] as const;

// ---- input ---------------------------------------------------------------------------------------

export const CustomerOrderListQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  customerId: z.string().uuid().optional(),
  /** open (default), closed, cancelled, a list of them, or all. */
  status: z.string().refine((v) => v === 'all' || v.split(',').every((x) => (ORDER_STATUSES as readonly string[]).includes(x)), 'Use all or known statuses').default('open'),
  /** Only orders with a line that is past its agreed (or requested) date and not fully shipped. */
  late: z.enum(['true']).optional(),
  sort: z.enum(ORDER_SORTS).default('orderedOn'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type CustomerOrderListQuery = z.infer<typeof CustomerOrderListQuery>;

export const OrderLookupQuery = z.object({ customerId: z.string().uuid().optional(), q: z.string().trim().min(1).max(100).optional() });
export type OrderLookupQuery = z.infer<typeof OrderLookupQuery>;

export const OrderLineInput = z
  .object({
    partId: z.string().uuid(),
    quantity: z.number().gt(0).max(999_999_999),
    unit: text(20),
    /** The date the customer asked for. It never changes. */
    requestedOn: DateOnly,
    agreedOn: DateOnly.nullable().optional(),
  })
  .strict();
export type OrderLineInput = z.infer<typeof OrderLineInput>;

export const CreateCustomerOrderBody = z
  .object({
    customerId: z.string().uuid(),
    orderNumber: z.string().trim().min(1, 'Give the order a number').max(40),
    /** The customer's own order number. */
    customerReference: text(60),
    orderedOn: DateOnly.optional(),
    notes: text(2000),
    lines: z.array(OrderLineInput).min(1).max(100),
  })
  .strict();
export type CreateCustomerOrderBody = z.infer<typeof CreateCustomerOrderBody>;

export const AgreedDateBody = z.object({ agreedOn: DateOnly.nullable() }).strict();
export type AgreedDateBody = z.infer<typeof AgreedDateBody>;
export const ReasonBody = z.object({ reason }).strict();
export type ReasonBody = z.infer<typeof ReasonBody>;

export const ShipmentListQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  customerId: z.string().uuid().optional(),
  customerOrderId: z.string().uuid().optional(),
  lotId: z.string().uuid().optional(),
  partId: z.string().uuid().optional(),
  status: z.enum(['shipped', 'cancelled', 'all']).default('shipped'),
  from: DateOnly.optional(),
  to: DateOnly.optional(),
  sort: z.enum(SHIPMENT_SORTS).default('shippedOn'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type ShipmentListQuery = z.infer<typeof ShipmentListQuery>;

export const ShipmentLineInput = z
  .object({
    orderLineId: z.string().uuid().nullable().optional(),
    partId: z.string().uuid().nullable().optional(),
    quantity: z.number().gt(0).max(999_999_999),
    /** An existing lot of the part (a shipment never makes a lot). Name it by id or by its lot number. */
    lotId: z.string().uuid().nullable().optional(),
    lotNumber: text(60),
    notes: text(1000),
  })
  .strict()
  .refine((l) => !!(l.orderLineId || l.partId), { message: 'Name an order line or a part' });
export type ShipmentLineInput = z.infer<typeof ShipmentLineInput>;

export const RecordShipmentBody = z
  .object({
    customerId: z.string().uuid(),
    customerOrderId: z.string().uuid().nullable().optional(),
    siteId: z.string().uuid().nullable().optional(),
    shippedOn: DateOnly,
    deliveryNote: text(100),
    notes: text(2000),
    lines: z.array(ShipmentLineInput).min(1).max(100),
    /** Sent by the client so that a retried request returns the same shipment instead of making another. */
    clientKey: z.string().trim().min(8).max(100).optional(),
  })
  .strict();
export type RecordShipmentBody = z.infer<typeof RecordShipmentBody>;

// ---- output --------------------------------------------------------------------------------------

const CustomerRef = z.object({ id: z.string().uuid(), code: z.string(), name: z.string() });
const PartRef = z.object({ id: z.string().uuid(), partNumber: z.string(), name: z.string() });

export const CustomerOrderRow = z.object({
  id: z.string().uuid(),
  orderNumber: z.string(),
  customerReference: z.string().nullable(),
  customer: CustomerRef,
  status: z.enum(ORDER_STATUSES),
  orderedOn: DateOnly,
  lineCount: z.number().int(),
  /** Open lines that still expect shipments, and how many of those are past their agreed (else requested) date. */
  outstandingLines: z.number().int(),
  lateLines: z.number().int(),
  nextDueOn: DateOnly.nullable(),
  createdAt: Iso,
});
export type CustomerOrderRow = z.infer<typeof CustomerOrderRow>;
export const CustomerOrderPage = z.object({ data: z.array(CustomerOrderRow), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });

const OrderLine = z.object({
  id: z.string().uuid(),
  lineNumber: z.number().int(),
  part: PartRef,
  quantityOrdered: z.number(),
  unit: z.string().nullable(),
  requestedOn: DateOnly,
  agreedOn: DateOnly.nullable(),
  /** The date that counts for "late" today: the latest agreed date, else the requested one. */
  dueOn: DateOnly,
  status: z.enum(ORDER_STATUSES),
  quantityShipped: z.number(),
  quantityOutstanding: z.number(),
  /** Shipped above the quantity ordered (allowed, shown). */
  quantityOver: z.number(),
  late: z.boolean(),
  daysLate: z.number().int(),
  firstShippedOn: DateOnly.nullable(),
  lastShippedOn: DateOnly.nullable(),
});
const ShipmentRef = z.object({ id: z.string().uuid(), reference: z.string(), shippedOn: DateOnly, deliveryNote: z.string().nullable(), status: z.enum(['shipped', 'cancelled']), lineCount: z.number().int() });
export const CustomerOrderDetail = CustomerOrderRow.extend({
  notes: z.string().nullable(),
  cancelReason: z.string().nullable(),
  closedAt: Iso.nullable(),
  createdBy: Person,
  lines: z.array(OrderLine),
  shipments: z.array(ShipmentRef),
});
export type CustomerOrderDetail = z.infer<typeof CustomerOrderDetail>;
export const OrderLookup = z.object({ data: z.array(z.object({ id: z.string().uuid(), orderNumber: z.string(), customer: CustomerRef })) });

export const ShipmentRow = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  customer: CustomerRef,
  customerOrder: z.object({ id: z.string().uuid(), orderNumber: z.string() }).nullable(),
  site: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  shippedOn: DateOnly,
  deliveryNote: z.string().nullable(),
  status: z.enum(['shipped', 'cancelled']),
  lineCount: z.number().int(),
  createdAt: Iso,
});
export type ShipmentRow = z.infer<typeof ShipmentRow>;
export const ShipmentPage = z.object({ data: z.array(ShipmentRow), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });

const ShipmentLine = z.object({
  id: z.string().uuid(),
  lineNumber: z.number().int(),
  orderLine: z.object({ id: z.string().uuid(), lineNumber: z.number().int() }).nullable(),
  part: PartRef,
  quantityShipped: z.number(),
  lot: z.object({ id: z.string().uuid(), lotNumber: z.string() }).nullable(),
  /** The lot's status now, so a shipment of a lot that is on hold or closed shows (information only). */
  lotStatus: z.string().nullable(),
  notes: z.string().nullable(),
});
export const ShipmentDetail = ShipmentRow.extend({
  notes: z.string().nullable(),
  cancelledAt: Iso.nullable(),
  cancelledBy: Person,
  cancelReason: z.string().nullable(),
  createdBy: Person,
  lines: z.array(ShipmentLine),
});
export type ShipmentDetail = z.infer<typeof ShipmentDetail>;
