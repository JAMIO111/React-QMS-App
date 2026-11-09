import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CATALOGUE, catalogueFor, EntityCatalogue } from './catalogue';
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

  async get(entity: string): Promise<EntityCatalogue | undefined> {
    const c = catalogueFor(entity);
    return c ? applyRules(c, await this.load()) : undefined;
  }

  async all(): Promise<EntityCatalogue[]> {
    const rules = await this.load();
    return CATALOGUE.map((c) => applyRules(c, rules));
  }
}
