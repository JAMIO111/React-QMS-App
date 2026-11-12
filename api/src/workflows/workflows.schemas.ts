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
export const Action = z.discriminatedUnion('type', [NotifyAction, TaskAction]);
export type Action = z.infer<typeof Action>;

const ConditionSchema = z
  .object({ field: z.string().min(1).max(60), op: z.enum(OPS as [Op, ...Op[]]), value: z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]).optional() })
  .strict();
export const ConditionsSchema = z.object({ all: z.array(ConditionSchema).max(20).optional(), any: z.array(ConditionSchema).max(20).optional() }).strict();

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

export const StatusBody = z.object({ status: z.enum(['active', 'paused', 'retired']), reason: z.string().trim().min(3).max(1000).optional() }).strict();
export const TaskListQuery = z.object({ status: z.enum(['open', 'done', 'all']).default('open') });
export const CompleteBody = z.object({ note: z.string().trim().max(2000).optional() }).strict();
export const CancelBody = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
