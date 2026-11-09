import type { PoolClient } from 'pg';

/** The kinds of record a connection can bring (plan §7); the database holds the same list (`app.integration_entity_types`). */
export const ENTITY_TYPES = [
  'supplier',
  'customer',
  'part',
  'machine',
  'employee',
  'gauge_type',
  'gauge',
  'nonconformance',
  'production_order',
  'purchase_order',
  'goods_receipt',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_LABELS: Record<EntityType, string> = {
  supplier: 'suppliers',
  customer: 'customers',
  part: 'parts',
  machine: 'machines',
  employee: 'employees',
  gauge_type: 'gauge types',
  gauge: 'gauges',
  nonconformance: 'non-conformances',
  production_order: 'production orders',
  purchase_order: 'purchase orders',
  goods_receipt: 'goods receipts',
};

/** A staged row waiting to be applied. `internalId` is the QMS record it already maps to (then `action` is update), else null (create). */
export interface StagedRow {
  id: string;
  externalId: string;
  sourceRow: number | null;
  payload: Record<string, unknown> | null;
  canonical: Record<string, unknown> | null;
  internalId: string | null;
  action: 'create' | 'update';
}

export interface ImportContext {
  organisationId: string;
  connectionId: string;
  runId: string;
  externalSystem: string;
  /** The person who started or approved the run; the audit trail records them as the actor. */
  initiatingUser: string | null;
  /** The lease owner of this call (the runner functions re-check it). */
  owner: string;
}

/**
 * Writes one kind of QMS record from a staged row (IN4–IN6 add one per entity). `apply` runs inside the batch transaction, in its own savepoint, on the API login,
 * so it may only call the SECURITY DEFINER import function made for its entity (which applies the same business rules as the screens); it must throw when the
 * row cannot be applied, with a message a person can act on. The engine records the map in the same savepoint, so a record and its map never disagree.
 */
export interface EntityImporter {
  entityType: EntityType;
  /** The source record's identifier until the mapping engine (IN3) names the key field. */
  externalIdOf(record: Record<string, unknown>): string | null;
  apply(client: PoolClient, row: StagedRow, ctx: ImportContext): Promise<{ internalId: string }>;
}

/** The importers this deployment has, by entity type. Empty until IN4: a run for a kind of record with no importer is refused. */
export class EntityImporterRegistry {
  private readonly importers = new Map<EntityType, EntityImporter>();

  register(importer: EntityImporter): this {
    if (this.importers.has(importer.entityType)) throw new Error(`Importer ${importer.entityType} is registered twice`);
    this.importers.set(importer.entityType, importer);
    return this;
  }

  get(entity: string): EntityImporter | undefined {
    return this.importers.get(entity as EntityType);
  }

  types(): EntityType[] {
    return [...this.importers.keys()];
  }
}
