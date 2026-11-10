import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CATALOGUE, CatalogueField, catalogueFor, EntityCatalogue } from './catalogue';
import { applyRules, CATALOGUE_TABLES, tableRules, TableRules } from './column-rules';

/**
 * The field catalogue as the database says it is: length limits, patterns, allowed values and numeric bounds are read once per process from the CHECK
 * constraints of the tables the importers write (they change only with a migration, which comes with a new deployment). If they cannot be read the
 * written catalogue is used; the database still enforces every rule when a row is written.
 */
@Injectable()
export class CatalogueService {
  private readonly log = new Logger(CatalogueService.name);
  private rules?: Promise<TableRules>;

  constructor(private readonly database: DatabaseService) {}

  private load(): Promise<TableRules> {
    this.rules ??= this.database
      .asApi(async (client) => {
        const res = await client.query<{ t: string; def: string }>(
          `select c.relname as t, pg_get_constraintdef(k.oid) as def
             from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
            where k.contype = 'c' and n.nspname = 'public' and c.relname = any($1::text[])`,
          [CATALOGUE_TABLES],
        );
        const byTable = new Map<string, string[]>();
        for (const r of res.rows) byTable.set(r.t, [...(byTable.get(r.t) ?? []), r.def]);
        return Object.fromEntries([...byTable].map(([t, defs]) => [t, tableRules(defs)]));
      }, '', 'integration')
      .catch((error: unknown) => {
        this.log.warn({ err: error instanceof Error ? error.message : 'unknown' }, 'could not read column rules; using the written catalogue');
        this.rules = undefined;
        return {};
      });
    return this.rules;
  }

  /**
   * A kind of record's catalogue. With `organisationId` the organisation's active custom fields are added as fields `cf_<key>` (read each time: they
   * change without a deployment); the database turns and checks their values when a row is imported (app.import_custom_values).
   */
  async get(entity: string, organisationId?: string): Promise<EntityCatalogue | undefined> {
    const c = catalogueFor(entity);
    if (!c) return undefined;
    const withRules = applyRules(c, await this.load());
    return organisationId ? { ...withRules, fields: [...withRules.fields, ...(await this.customFields(organisationId, entity))] } : withRules;
  }

  async all(organisationId?: string): Promise<EntityCatalogue[]> {
    return Promise.all(CATALOGUE.map(async (c) => (await this.get(c.entityType, organisationId))!));
  }

  /** The organisation's active custom fields of a kind of record as catalogue fields. */
  async customFields(organisationId: string, entity: string): Promise<CatalogueField[]> {
    const defs = await this.database.asApi(
      async (client) => (await client.query<{ c: CustomDefinition[] }>('select app.custom_field_catalogue($1::uuid, $2) as c', [organisationId, entity])).rows[0]?.c ?? [],
      '',
      'integration',
    );
    return defs.map(customField);
  }
}

interface CustomDefinition {
  key: string;
  label: string;
  fieldType: string;
  requiredAt: string;
  helpText: string | null;
  options: { key: string; label: string }[];
  min: number | null;
  max: number | null;
  decimals: number | null;
  unit: string | null;
}

/** A custom field as a catalogue field: the file's text is turned into its stored value here (type) or by the database (choices, people). */
export function customField(d: CustomDefinition): CatalogueField {
  const base: CatalogueField = { key: `cf_${d.key}`, label: d.label, type: 'text', required: d.requiredAt === 'save', custom: true, description: d.helpText ?? undefined };
  switch (d.fieldType) {
    case 'long_text':
      return { ...base, maxLength: 5000 };
    case 'number':
      return { ...base, type: 'number', min: d.min ?? undefined, max: d.max ?? undefined, description: [d.helpText, d.unit && `In ${d.unit}`, d.decimals != null && `At most ${d.decimals} decimal places`].filter(Boolean).join('. ') || undefined };
    case 'date':
      return { ...base, type: 'date' };
    case 'boolean':
      return { ...base, type: 'boolean' };
    case 'choice':
      return { ...base, type: 'enum', options: d.options.map((o) => ({ value: o.key, label: o.label })) };
    case 'multi_choice':
      return { ...base, maxLength: 2000, description: `Any of ${d.options.map((o) => o.label).join(', ')}, separated by commas` };
    case 'person':
      return { ...base, maxLength: 320, description: 'The email address or full name of a member of the organisation' };
    default:
      return { ...base, maxLength: 500 };
  }
}
