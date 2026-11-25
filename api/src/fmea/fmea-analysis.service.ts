import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { FmeaService } from './fmea.service';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const json = (v: unknown) => JSON.stringify(v);

type Node = 'item' | 'function' | 'failure_mode' | 'effect' | 'cause';
const TABLE: Record<Node, string> = { item: 'fmea_items', function: 'fmea_functions', failure_mode: 'fmea_failure_modes', effect: 'fmea_effects', cause: 'fmea_causes' };

/**
 * FMEA (FM3): the analysis net of a draft revision. Every write is a database function that checks the draft, the kind rules and scores the causes;
 * each command answers with the whole revision (net, model, still-needed list) so the screen never has to work anything out.
 */
@Injectable()
export class FmeaAnalysisService {
  constructor(
    private readonly database: DatabaseService,
    private readonly fmea: FmeaService,
  ) {}

  /** The revision a node belongs to, found under the caller's organisation (a stranger's id is a 404, as is a node the caller may not read). */
  private async revisionOf(db: Db, ctx: RequestContext, table: string, id: string): Promise<string> {
    const found = (await db.execute<Row>(sql`select revision_id from public.${sql.raw(table)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`)).rows[0];
    if (!found) throw ApiError.notFound('fmea_not_found', 'Not found');
    return found.revision_id as string;
  }

  private run(ctx: RequestContext, revisionId: string | null, table: string | null, id: string | null, statement: (revision: string) => SQL) {
    return this.database.asUser(ctx, async (db) => {
      const revision = revisionId ?? (await this.revisionOf(db, ctx, table!, id!));
      await db.execute(statement(revision));
      return this.fmea.revision(db, ctx, revision);
    });
  }

  addItem(ctx: RequestContext, revisionId: string, body: object) {
    return this.run(ctx, revisionId, null, null, () => sql`select app.save_fmea_item(${revisionId}::uuid, null, ${json(body)}::jsonb)`);
  }
  updateItem(ctx: RequestContext, id: string, body: object) {
    return this.run(ctx, null, TABLE.item, id, (rev) => sql`select app.save_fmea_item(${rev}::uuid, ${id}::uuid, ${json(body)}::jsonb)`);
  }
  addFunction(ctx: RequestContext, itemId: string, body: object) {
    return this.run(ctx, null, TABLE.item, itemId, () => sql`select app.save_fmea_function(${itemId}::uuid, null, ${json(body)}::jsonb)`);
  }
  updateFunction(ctx: RequestContext, id: string, body: object) {
    return this.run(ctx, null, TABLE.function, id, () => sql`select app.save_fmea_function(null, ${id}::uuid, ${json(body)}::jsonb)`);
  }
  addFailureMode(ctx: RequestContext, functionId: string, body: object) {
    return this.run(ctx, null, TABLE.function, functionId, () => sql`select app.save_fmea_failure_mode(${functionId}::uuid, null, ${json(body)}::jsonb)`);
  }
  updateFailureMode(ctx: RequestContext, id: string, body: object) {
    return this.run(ctx, null, TABLE.failure_mode, id, () => sql`select app.save_fmea_failure_mode(null, ${id}::uuid, ${json(body)}::jsonb)`);
  }
  addEffect(ctx: RequestContext, modeId: string, body: object) {
    return this.run(ctx, null, TABLE.failure_mode, modeId, () => sql`select app.save_fmea_effect(${modeId}::uuid, null, ${json(body)}::jsonb)`);
  }
  updateEffect(ctx: RequestContext, id: string, body: object) {
    return this.run(ctx, null, TABLE.effect, id, () => sql`select app.save_fmea_effect(null, ${id}::uuid, ${json(body)}::jsonb)`);
  }
  addCause(ctx: RequestContext, modeId: string, body: object) {
    return this.run(ctx, null, TABLE.failure_mode, modeId, () => sql`select app.save_fmea_cause(${modeId}::uuid, null, ${json(body)}::jsonb)`);
  }
  updateCause(ctx: RequestContext, id: string, body: object) {
    return this.run(ctx, null, TABLE.cause, id, () => sql`select app.save_fmea_cause(null, ${id}::uuid, ${json(body)}::jsonb)`);
  }
  remove(ctx: RequestContext, node: Node, id: string) {
    return this.run(ctx, null, TABLE[node], id, () => sql`select app.remove_fmea_node(${node}, ${id}::uuid)`);
  }
  useLatestModel(ctx: RequestContext, revisionId: string) {
    return this.run(ctx, revisionId, null, null, () => sql`select app.set_fmea_revision_model(${revisionId}::uuid)`);
  }
}
