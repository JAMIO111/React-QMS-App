import { z } from 'zod';
import { Uuid } from '../common/validation';

export const NotificationsQuery = z.object({
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const MarkReadBody = z
  .object({ ids: z.array(Uuid).min(1).max(200).optional(), all: z.boolean().optional() })
  .strict()
  .refine((b) => b.all === true || (b.ids?.length ?? 0) > 0, { message: 'Provide ids or all: true' });
export type MarkReadBody = z.infer<typeof MarkReadBody>;

/** In the app (`enabled`) and/or by email (`email`); null puts that choice back to the default. At least one of the two. */
export const SetPreferenceBody = z
  .object({ eventKey: z.string().regex(/^[a-z_]+\.(created|updated|deleted)$/), enabled: z.boolean().nullable().optional(), email: z.boolean().nullable().optional() })
  .strict()
  .refine((b) => b.enabled !== undefined || b.email !== undefined, { message: 'Give enabled and/or email' });
export type SetPreferenceBody = z.infer<typeof SetPreferenceBody>;

export const NotificationItem = z.object({
  id: z.string(),
  eventKey: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  details: z.record(z.unknown()),
  actorUserId: z.string().nullable(),
  createdAt: z.string(),
  read: z.boolean(),
});
export type NotificationItem = z.infer<typeof NotificationItem>;

export const NotificationList = z.object({ data: z.array(NotificationItem), unread: z.number().int() });

export const NotificationPreference = z.object({
  eventKey: z.string(),
  group: z.string(),
  entity: z.string(),
  action: z.enum(['created', 'updated', 'deleted']),
  description: z.string(),
  enabled: z.boolean(),
  defaultEnabled: z.boolean(),
  overridden: z.boolean(),
  /** Also by email (only ever true while it is shown in the app). */
  email: z.boolean(),
  emailDefault: z.boolean(),
  emailOverridden: z.boolean(),
});
export type NotificationPreference = z.infer<typeof NotificationPreference>;
