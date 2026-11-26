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

/** An approved change that names this order's part or order, or has its cut-in point at it; `position` says where the subject stands against the cut-in point. */
const TraceChange = z.object({
  id: Id,
  reference: z.string(),
  title: z.string(),
  stage: z.string(),
  cutIn: z.object({ kind: z.enum(['none', 'date', 'order', 'lot', 'serial']), label: z.string().nullable(), date: z.string().nullable(), stockAction: z.string().nullable() }),
  /** at: the cut-in point is this record; before / after: built before or after it (by when each was created in Fortress); null: no fixed point. */
  position: z.enum(['at', 'before', 'after']).nullable(),
});

/**
 * An FMEA that covers this subject's part (named on a part or its family): the revision that was in force on the day the subject was created in Fortress (`then`, null when none
 * was yet), and the one in force now (`now`, null when the FMEA is no longer in force), so a lot made under rev A shows that the analysis is at rev B today.
 */
const TraceFmeaRevision = z.object({ id: Id, letter: z.string().nullable(), effectiveFrom: z.string().nullable() });
const TraceFmea = z.object({
  id: Id,
  number: z.string(),
  title: z.string(),
  kind: z.enum(['design', 'process']),
  then: TraceFmeaRevision.nullable(),
  now: TraceFmeaRevision.nullable(),
  /** The analysis has moved on since: the revision in force then is not the one in force now. */
  changedSince: z.boolean(),
});

/**
 * A part approval (PPAP) for this subject's part that was sent or received, with where it stood on the day the subject was created in Fortress (`then`) and where it stands now: the lot
 * made under an interim approval that has since run out, or before the part was approved at all, says so. Information only.
 */
export const TRACE_PPAP_THEN = ['not_sent', 'no_answer', 'approved', 'interim_approved', 'interim_lapsed', 'rejected'] as const;
const TracePpap = z.object({
  id: Id,
  reference: z.string(),
  direction: z.enum(['submitted', 'received']),
  party: z.string().nullable(),
  level: z.number(),
  revision: z.string().nullable(),
  status: z.string(),
  sentOn: z.string().nullable(),
  then: z.enum(TRACE_PPAP_THEN),
  /** The day the answer in force then was recorded (and, for an interim approval, the day it ran to). */
  thenOn: z.string().nullable(),
  thenExpiresOn: z.string().nullable(),
  /** The day the interim approval in force now runs to. */
  interimExpiresOn: z.string().nullable(),
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
  changes: z.object({ available: z.boolean(), data: z.array(TraceChange) }),
  fmeas: z.object({ available: z.boolean(), data: z.array(TraceFmea) }),
  ppaps: z.object({ available: z.boolean(), data: z.array(TracePpap) }),
  equipment: z.object({
    machines: z.array(z.object({ id: Id, code: z.string(), name: z.string(), inspections: z.number(), operations: z.number() })),
    gauges: z.array(z.object({ id: Id, assetNumber: z.string(), readings: z.number(), outOfCalibration: z.number(), lastUsed: dateTime })),
  }),
});
export type Traceability = z.infer<typeof Traceability>;
