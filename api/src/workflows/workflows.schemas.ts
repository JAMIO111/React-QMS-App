import { z } from 'zod';
import { Op, OPS } from './conditions';

const Id = z.string().uuid();
export const Recipient = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), userId: Id }).strict(),
  z.object({ kind: z.literal('role'), roleId: Id }).strict(),
  z.object({ kind: z.literal('department'), departmentId: Id }).strict(),
  z.object({ kind: z.literal('record_owner') }).strict(),
]);
export const Assignee = z.discriminatedUnion('kind', [z.object({ kind: z.literal('person'), userId: Id }).strict(), z.object({ kind: z.literal('record_owner') }).strict()]);

export const NotifyAction = z
  .object({ type: z.literal('notify'), recipients: z.array(Recipient).min(1).max(20), message: z.string().trim().min(1).max(500) })
  .strict();
export const TaskAction = z
  .object({
    type: z.literal('task'),
    assignee: Assignee,
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().max(2000).optional(),
    dueDays: z.number().int().min(0).max(365).optional(),
  })
  .strict();
/** Put the lot of the record on hold, with the authority of the person who saved the rule version (WF3). */
export const HoldLotAction = z.object({ type: z.literal('hold_lot'), reason: z.string().trim().min(3).max(500) }).strict();

const ConditionSchema = z
  .object({ field: z.string().min(1).max(60), op: z.enum(OPS as [Op, ...Op[]]), value: z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]).optional() })
  .strict();
export const ConditionsSchema = z.object({ all: z.array(ConditionSchema).max(20).optional(), any: z.array(ConditionSchema).max(20).optional() }).strict();

/** What a timer may do once it runs: tell people, give a task, hold the lot (never another timer). */
export const InnerAction = z.discriminatedUnion('type', [NotifyAction, TaskAction, HoldLotAction]);
export type InnerAction = z.infer<typeof InnerAction>;

/** After N days, if the record still meets these conditions (read again then), do these (WF3: escalation). */
export const LaterAction = z
  .object({ type: z.literal('later'), afterDays: z.number().int().min(1).max(365), conditions: ConditionsSchema.default({ all: [] }), actions: z.array(InnerAction).min(1).max(5) })
  .strict();
export const Action = z.discriminatedUnion('type', [NotifyAction, TaskAction, HoldLotAction, LaterAction]);
export type Action = z.infer<typeof Action>;

export const CreateRuleBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    trigger: z.string().min(1).max(80),
    conditions: ConditionsSchema.default({ all: [] }),
    actions: z.array(Action).min(1).max(10),
  })
  .strict();
export type CreateRuleBody = z.infer<typeof CreateRuleBody>;

export const UpdateRuleBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    trigger: z.string().min(1).max(80).optional(),
    conditions: ConditionsSchema.optional(),
    actions: z.array(Action).min(1).max(10).optional(),
    reason: z.string().trim().min(3).max(1000).optional(),
  })
  .strict();
export type UpdateRuleBody = z.infer<typeof UpdateRuleBody>;

/** A dry run (WF2): what a rule as written now would do for one recent event. Nothing is saved or sent. */
export const TestBody = z
  .object({ trigger: z.string().min(1).max(80), conditions: ConditionsSchema.default({ all: [] }), actions: z.array(Action).max(10).default([]), eventId: z.coerce.number().int().positive() })
  .strict();
export type TestBody = z.infer<typeof TestBody>;
export const TestEventsQuery = z.object({ trigger: z.string().min(1).max(80) });

export const StatusBody = z.object({ status: z.enum(['active', 'paused', 'retired']), reason: z.string().trim().min(3).max(1000).optional() }).strict();
export const TaskListQuery = z.object({ status: z.enum(['open', 'done', 'all']).default('open') });
export const CompleteBody = z.object({ note: z.string().trim().max(2000).optional() }).strict();
export const CancelBody = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
