import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();

export const CONNECTION_STATUSES = ['draft', 'ready', 'active', 'paused', 'retired'] as const;
export const CREDENTIAL_KINDS = ['api_key', 'bearer', 'basic', 'oauth_client'] as const;

/** Non-secret settings only; the database checks the keys and values per provider (and refuses unknown or secret-looking keys). */
const Config = z.record(z.string().max(60), z.union([z.string().max(400), z.number(), z.boolean()])).refine((c) => Object.keys(c).length <= 20, 'Too many settings');

export const CreateConnectionBody = z
  .object({
    providerKey: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
    name: z.string().trim().min(2).max(80),
    externalSystem: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/, 'Use 2 to 40 lower-case letters, digits, hyphens or underscores, starting with a letter'),
    config: Config.optional(),
  })
  .strict();
export type CreateConnectionBody = z.infer<typeof CreateConnectionBody>;

export const UpdateConnectionBody = z
  .object({ name: z.string().trim().min(2).max(80).optional(), config: Config.optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.config !== undefined, 'Nothing to change');
export type UpdateConnectionBody = z.infer<typeof UpdateConnectionBody>;

/** The credential value is sent once over TLS and is never returned, logged or stored outside Vault. */
export const CredentialBody = z.object({ kind: z.enum(CREDENTIAL_KINDS), secret: z.string().min(1).max(4000) }).strict();
export type CredentialBody = z.infer<typeof CredentialBody>;

export const ReasonBody = z.object({ reason: z.string().trim().min(3, 'Say why').max(1000) }).strict();
export type ReasonBody = z.infer<typeof ReasonBody>;

export const EmptyBody = z.object({}).strict();

// ---- output --------------------------------------------------------------------------------------

export const Provider = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(['file', 'api', 'agent']),
  authTypes: z.array(z.string()),
  capabilities: z.object({ testable: z.boolean(), incremental: z.boolean(), webhooks: z.boolean(), writeBack: z.boolean() }),
  status: z.enum(['available', 'planned', 'retired']),
});
export const ProviderList = z.object({ data: z.array(Provider) });

const ConnectionBase = {
  id: z.string().uuid(),
  provider: z.object({ key: z.string(), name: z.string(), kind: z.enum(['file', 'api', 'agent']) }),
  name: z.string(),
  externalSystem: z.string(),
  status: z.enum(CONNECTION_STATUSES),
  config: z.record(z.string(), z.unknown()),
  lastTest: z.object({ at: Iso, ok: z.boolean(), message: z.string().nullable() }).nullable(),
  readyAt: Iso.nullable(),
  readyBy: Person,
  activatedAt: Iso.nullable(),
  activatedBy: Person,
  createdAt: Iso,
  createdBy: Person,
};
export const ConnectionRow = z.object(ConnectionBase);
export const ConnectionList = z.object({ data: z.array(ConnectionRow) });

export const ConnectionDetail = z.object({
  ...ConnectionBase,
  /** Null when there is no live credential, or the caller may not see them (integrations.manage). The value is never included. */
  credential: z.object({ kind: z.enum(CREDENTIAL_KINDS), setAt: Iso, setBy: Person }).nullable(),
  /** What still stops the connection being made ready or activated, in plain sentences. */
  problems: z.array(z.string()),
  /** The kinds of record this connection can import with what this deployment has (empty until an importer exists for its provider). */
  runnable: z.array(z.string()),
  events: z.array(z.object({ action: z.string(), fromStatus: z.string().nullable(), toStatus: z.string().nullable(), note: z.string().nullable(), at: Iso, by: Person })),
});
export type ConnectionDetail = z.infer<typeof ConnectionDetail>;
