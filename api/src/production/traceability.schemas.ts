import { z } from 'zod';

const dateTime = z.string().datetime({ offset: true });
const Id = z.string().uuid();

export const SUBJECT_TYPES = ['order', 'lot', 'serial'] as const;
export const TraceQuery = z.object({ type: z.enum(SUBJECT_TYPES), id: Id }).strict();
export const TraceSearchQuery = z.object({ q: z.string().trim().min(1).max(60) }).strict();

const PartRef = z.object({ id: Id, partNumber: z.string(), name: z.string() });
const Party = z.object({ id: Id, name: z.string() }).nullable();

export const TraceSearchResult = z.object({ type: z.enum(SUBJECT_TYPES), id: Id, number: z.string(), status: z.string(), part: PartRef });

/** What something found was matched through (an NC raised on the order, or one that names an affected lot). */
const TraceNcr = z.object({
  id: Id,
  reference: z.string(),
  title: z.string(),
  stage: z.string(),
  source: z.string(),
  severity: z.string().nullable(),
  quantityAffected: z.number().nullable(),
  matchedVia: z.enum(['linked', 'affected_lot']),
  containment: z.object({ open: z.number(), done: z.number() }),
  dispositions: z.object({ proposed: z.number(), approved: z.number(), approvedQuantity: z.number() }),
  capas: z.array(z.object({ id: Id, reference: z.string(), stage: z.string(), title: z.string() })),
});

export const Traceability = z.object({
  subject: z.object({
    type: z.enum(SUBJECT_TYPES),
    id: Id,
    number: z.string(),
    status: z.string(),
    part: PartRef,
    partRevision: z.string().nullable(),
    customer: Party,
    supplier: Party,
    site: Party,
    quantity: z.number().nullable(),
  }),
  /** The production order (the subject itself, or the one a lot or serial number belongs to). */
  order: z
    .object({
      id: Id,
      orderNumber: z.string(),
      status: z.string(),
      quantityPlanned: z.number(),
      dueDate: z.string().nullable(),
      operations: z.array(z.object({ id: Id, sequence: z.number(), code: z.string(), description: z.string().nullable(), status: z.string(), machine: z.object({ id: Id, code: z.string(), name: z.string() }).nullable() })),
    })
    .nullable(),
  lots: z.object({ total: z.number(), data: z.array(z.object({ id: Id, lotNumber: z.string(), status: z.string(), statusReason: z.string().nullable(), origin: z.string(), quantity: z.number().nullable(), supplier: Party })) }),
  serials: z.object({ total: z.number(), data: z.array(z.object({ id: Id, serialNumber: z.string(), status: z.string(), lot: z.object({ id: Id, lotNumber: z.string() }).nullable() })) }),
  inspections: z.object({
    available: z.boolean(),
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    inProgress: z.number(),
    data: z.array(
      z.object({
        id: Id,
        reference: z.string(),
        status: z.string(),
        result: z.string().nullable(),
        operationCode: z.string().nullable(),
        startedAt: dateTime,
        failures: z.number(),
        machine: z.object({ id: Id, code: z.string(), name: z.string() }).nullable(),
        lot: z.string().nullable(),
        serial: z.string().nullable(),
      })
    ),
  }),
  ncrs: z.object({ available: z.boolean(), total: z.number(), data: z.array(TraceNcr) }),
  equipment: z.object({
    machines: z.array(z.object({ id: Id, code: z.string(), name: z.string(), inspections: z.number(), operations: z.number() })),
    gauges: z.array(z.object({ id: Id, assetNumber: z.string(), readings: z.number(), outOfCalibration: z.number(), lastUsed: dateTime })),
  }),
});
export type Traceability = z.infer<typeof Traceability>;
