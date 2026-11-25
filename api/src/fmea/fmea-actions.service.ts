import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { compareRevisions, CompareRow, NodeKind } from './fmea-compare';
import { CompleteActionBody, CreateActionBody, MyActionsQuery, UpdateActionBody } from './fmea.schemas';
import { ACTION_SELECT, FmeaService, toAction } from './fmea.service';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const json = (v: unknown) => JSON.stringify(v);

/**
 * FMEA (FM4): actions on causes, the revised figures the database works out, My actions, and comparing revisions. Every write is a database function; commands that change
 * an existing action answer with that action (an owner who only reads the FMEA could not be given the whole draft revision), adding one answers with the whole revision.
 */
@Injectable()
export class FmeaActionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly fmea: FmeaService,
  ) {}

  private async found(db: Db, ctx: RequestContext, table: string, id: string, columns: string): Promise<Row> {
    const row = (await db.execute<Row>(sql`select ${sql.raw(columns)} from public.${sql.raw(table)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`)).rows[0];
    if (!row) throw ApiError.notFound('fmea_not_found', 'Not found');
    return row;
  }

  /** The action as the caller may see it: through My actions when it is theirs (that works on a draft they cannot otherwise open), else under their own read rights. */
  private async answer(db: Db, ctx: RequestContext, id: string) {
    const org = orgOf(ctx);
    const mine = (await db.execute<Row>(sql`select x from app.my_fmea_actions(${org}::uuid, 'all') x`)).rows.map((r) => r.x as Row).find((x) => x.id === id);
    const can = (await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'fmea.manage') as manage`)).rows[0];
    const row = (await db.execute<Row>(sql`${ACTION_SELECT} where a.id = ${id}::uuid and a.organisation_id = ${org}::uuid`)).rows[0];
    if (row) {
      const status = (await db.execute<Row>(sql`select status from public.fmea_revisions where id = ${row.revision_id as string}::uuid`)).rows[0]?.status as string;
      return toAction(row, status === 'draft' || status === 'effective', Boolean(can.manage));
    }
    if (mine) return mine;
    throw ApiError.notFound('fmea_not_found', 'Not found');
  }

  // ---- the commands --------------------------------------------------------------------------------------------------

  addAction(ctx: RequestContext, causeId: string, body: CreateActionBody) {
    return this.database.asUser(ctx, async (db) => {
      const cause = await this.found(db, ctx, 'fmea_causes', causeId, 'revision_id');
      await db.execute(sql`select app.add_fmea_action(${causeId}::uuid, ${json(body)}::jsonb)`);
      return this.fmea.revision(db, ctx, cause.revision_id as string);
    });
  }

  private command(ctx: RequestContext, id: string, statement: ReturnType<typeof sql>) {
    return this.database.asUser(ctx, async (db) => {
      await this.found(db, ctx, 'fmea_actions', id, 'id').catch(async (e) => {
        // A person the action is given to may not be able to read its row: the function decides whether they may act.
        const mine = (await db.execute<Row>(sql`select x from app.my_fmea_actions(${orgOf(ctx)}::uuid, 'all') x`)).rows.some((r) => (r.x as Row).id === id);
        if (!mine) throw e;
      });
      await db.execute(statement);
      return this.answer(db, ctx, id);
    });
  }

  updateAction(ctx: RequestContext, id: string, body: UpdateActionBody) {
    return this.command(ctx, id, sql`select app.update_fmea_action(${id}::uuid, ${json(body)}::jsonb)`);
  }

  completeAction(ctx: RequestContext, id: string, body: CompleteActionBody) {
    const data = { ...(body.revisedOccurrence != null ? { revisedOccurrence: body.revisedOccurrence } : {}), ...(body.revisedDetection != null ? { revisedDetection: body.revisedDetection } : {}) };
    return this.command(ctx, id, sql`select app.complete_fmea_action(${id}::uuid, ${body.note}, ${json(data)}::jsonb)`);
  }

  cancelAction(ctx: RequestContext, id: string, reason: string) {
    return this.command(ctx, id, sql`select app.cancel_fmea_action(${id}::uuid, ${reason})`);
  }

  reopenAction(ctx: RequestContext, id: string) {
    return this.command(ctx, id, sql`select app.reopen_fmea_action(${id}::uuid)`);
  }

  // ---- My actions ----------------------------------------------------------------------------------------------------

  /** The actions given to the caller on any draft or revision in force. `openCount` and `overdueCount` are for the menu badge. */
  mine(ctx: RequestContext, q: MyActionsQuery) {
    return this.database.asUser(ctx, async (db) => {
      const org = orgOf(ctx);
      const rows = (await db.execute<Row>(sql`select x from app.my_fmea_actions(${org}::uuid, ${q.status}) x`)).rows.map((r) => r.x as Row);
      const open = q.status === 'open' ? rows : (await db.execute<Row>(sql`select x from app.my_fmea_actions(${org}::uuid, 'open') x`)).rows.map((r) => r.x as Row);
      const today = (await db.execute<Row>(sql`select current_date::text as d`)).rows[0].d as string;
      return { data: rows, openCount: open.length, overdueCount: open.filter((a) => String(a.dueOn) < today).length };
    });
  }

  // ---- comparing -----------------------------------------------------------------------------------------------------

  /** Every analysis row of the given revisions, with its lineage, as the comparison wants it. Read as the caller. */
  private async rowsOf(db: Db, ctx: RequestContext, revisionIds: string[]): Promise<CompareRow[]> {
    const org = orgOf(ctx);
    const ids = `{${revisionIds.join(',')}}`;
    const query = (table: string, columns: string, parent: string) =>
      db.execute<Row>(sql`select id, revision_id, prev_row_id, ${sql.raw(parent)} as parent_id, ${sql.raw(columns)} from public.${sql.raw(table)}
                           where organisation_id = ${org}::uuid and revision_id = any(${ids}::uuid[])`);
    const [items, fns, modes, effects, causes] = await Promise.all([
      query('fmea_items', 'name, element_type, description, operation_code', 'parent_id'),
      query('fmea_functions', 'text, requirement, characteristic_key', 'item_id'),
      query('fmea_failure_modes', 'text, special_class', 'function_id'),
      query('fmea_effects', 'level, text, severity', 'failure_mode_id'),
      query('fmea_causes', 'text, prevention_controls, detection_controls, occurrence, detection, severity_used, rpn, priority, no_action_reason', 'failure_mode_id'),
    ]);
    const n = (v: unknown) => (v == null ? null : Number(v));
    const s = (v: unknown) => (v == null ? null : String(v));
    const make = (kind: NodeKind, r: Row, fields: CompareRow['fields']): CompareRow => ({
      id: r.id as string, kind, revisionId: r.revision_id as string, prevRowId: (r.prev_row_id as string) ?? null, parentId: (r.parent_id as string) ?? null, fields,
    });
    return [
      ...items.rows.map((r) => make('item', r, { name: s(r.name), elementType: s(r.element_type), description: s(r.description), operationCode: s(r.operation_code) })),
      ...fns.rows.map((r) => make('function', r, { text: s(r.text), requirement: s(r.requirement), characteristicKey: s(r.characteristic_key) })),
      ...modes.rows.map((r) => make('failure_mode', r, { text: s(r.text), specialClass: s(r.special_class) })),
      ...effects.rows.map((r) => make('effect', r, { level: s(r.level), text: s(r.text), severity: n(r.severity) })),
      ...causes.rows.map((r) =>
        make('cause', r, {
          text: s(r.text), preventionControls: s(r.prevention_controls), detectionControls: s(r.detection_controls), occurrence: n(r.occurrence), detection: n(r.detection),
          severityUsed: n(r.severity_used), rpn: n(r.rpn), priority: s(r.priority), noActionReason: s(r.no_action_reason),
        }),
      ),
    ];
  }

  private async revisionHeader(db: Db, ctx: RequestContext, id: string) {
    const r = (
      await db.execute<Row>(sql`
        select v.id, v.fmea_id, v.letter, v.status, v.sequence, v.previous_revision_id, v.based_on_revision_id, f.number, f.title
          from public.fmea_revisions v join public.fmeas f on f.id = v.fmea_id where v.id = ${id}::uuid and v.organisation_id = ${orgOf(ctx)}::uuid`)
    ).rows[0];
    if (!r) throw ApiError.notFound('fmea_revision_not_found', 'Revision not found');
    return r;
  }

  private async revisionsOf(db: Db, ctx: RequestContext, fmeaId: string): Promise<string[]> {
    return (await db.execute<Row>(sql`select id from public.fmea_revisions where fmea_id = ${fmeaId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`)).rows.map((r) => r.id as string);
  }

  /**
   * What changed between a revision and an earlier one of the same FMEA (the one before it unless `with` names another): rows added, removed and changed, each changed field
   * with what it was. Matched by lineage, never by wording.
   */
  compare(ctx: RequestContext, id: string, withId?: string) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.settle_fmeas(${orgOf(ctx)}::uuid)`);
      const newer = await this.revisionHeader(db, ctx, id);
      const olderId = withId ?? (newer.previous_revision_id as string | null);
      if (!olderId) return { comparable: false as const, reason: 'This is the first revision, so there is nothing before it to compare with.', newer: this.head(newer) };
      const older = await this.revisionHeader(db, ctx, olderId);
      if (older.fmea_id !== newer.fmea_id) throw ApiError.badRequest('fmea_compare_other_fmea', 'Revisions of one FMEA can be compared with each other');
      if (Number(older.sequence) >= Number(newer.sequence)) throw ApiError.badRequest('fmea_compare_order', 'Compare a revision with an earlier one');
      const rows = await this.rowsOf(db, ctx, await this.revisionsOf(db, ctx, newer.fmea_id as string));
      return { comparable: true as const, older: this.head(older), newer: this.head(newer), ...compareRevisions(rows, older.id as string, newer.id as string) };
    });
  }

  /**
   * An FMEA that was started from a base keeps its own copy; this lists what has changed in the base since then (the base revision it was copied from against the base's
   * revision in force now), so the team can choose what to bring across. Nothing is changed. A base the caller may not read has nothing to show.
   */
  baseChanges(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.settle_fmeas(${orgOf(ctx)}::uuid)`);
      const mine = await this.revisionHeader(db, ctx, id);
      if (!mine.based_on_revision_id) return { hasBase: false as const };
      const copied = (
        await db.execute<Row>(sql`select v.id, v.fmea_id, v.letter, v.sequence, f.number, f.title, f.current_revision_id
                                    from public.fmea_revisions v join public.fmeas f on f.id = v.fmea_id
                                   where v.id = ${mine.based_on_revision_id as string}::uuid and v.organisation_id = ${orgOf(ctx)}::uuid`)
      ).rows[0];
      if (!copied) return { hasBase: true as const, readable: false as const };
      const nowId = copied.current_revision_id as string | null;
      if (!nowId || nowId === copied.id) {
        return { hasBase: true as const, readable: true as const, moved: false as const, base: { fmeaId: copied.fmea_id as string, number: copied.number as string, title: copied.title as string, copiedLetter: (copied.letter as string) ?? null } };
      }
      const now = await this.revisionHeader(db, ctx, nowId);
      const rows = await this.rowsOf(db, ctx, await this.revisionsOf(db, ctx, copied.fmea_id as string));
      const result = compareRevisions(rows, copied.id as string, nowId);
      return {
        hasBase: true as const, readable: true as const, moved: true as const,
        base: { fmeaId: copied.fmea_id as string, number: copied.number as string, title: copied.title as string, copiedLetter: (copied.letter as string) ?? null, currentLetter: (now.letter as string) ?? null },
        ...result,
      };
    });
  }

  private head(r: Row) {
    return { id: r.id as string, fmeaId: r.fmea_id as string, number: r.number as string, title: r.title as string, letter: (r.letter as string) ?? null, status: r.status as string, sequence: Number(r.sequence) };
  }
}
