import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import {
  AddAffectedLotBody,
  AffectedLot,
  AffectedLots,
  CompleteContainmentBody,
  Containment,
  ContainmentAction,
  CreateContainmentBody,
  CreateDispositionBody,
  Disposition,
  Dispositions,
  Gates,
  UpdateAffectedLotBody,
  UpdateContainmentBody,
  UpdateDispositionBody,
} from './ncr-workflow.schemas';

type Row = Record<string, unknown>;
const num = (v: unknown) => (v == null ? null : Number(v));
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const person = (alias: string) => `nullif(trim(concat_ws(' ', ${alias}.first_name, ${alias}.surname)), '')`;
const ref = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown user' } : null);

const CONTAINMENT_COLUMNS: Record<string, string> = { kind: 'kind', description: 'description', ownerEmployeeId: 'owner_employee_id', dueDate: 'due_date', quantityContained: 'quantity_contained', lotId: 'lot_id' };
const DISPOSITION_COLUMNS: Record<string, string> = { decision: 'decision', quantity: 'quantity', instructions: 'instructions', reference: 'reference', lotId: 'lot_id' };

const CONTAINMENT_SELECT = `
  select a.id, a.nonconformance_id, a.kind, a.description, a.owner_employee_id, ${person('oe')} as owner_name, to_char(a.due_date, 'YYYY-MM-DD') as due_date,
         a.quantity_contained, a.lot_id, lt.lot_number, a.status, a.done_note, a.done_at, a.done_by, ${person('dp')} as done_name, a.cancel_reason, a.created_at, a.created_by, ${person('cp')} as created_name
    from public.ncr_containment_actions a
    left join public."Employees" oe on oe.id = a.owner_employee_id
    left join public.profiles dp on dp.id = a.done_by
    left join public.lots lt on lt.id = a.lot_id
    left join public.profiles cp on cp.id = a.created_by`;
const DISPOSITION_SELECT = `
  select d.id, d.nonconformance_id, d.decision, d.quantity, d.instructions, d.reference, d.lot_id, lt.lot_number, d.status, d.approved_at, d.approved_by, ${person('ap')} as approved_name, d.approval_note,
         d.cancelled_at, d.cancelled_by, ${person('xp')} as cancelled_name, d.cancel_reason, d.created_at, d.created_by, ${person('cp')} as created_name
    from public.ncr_dispositions d
    left join public.profiles ap on ap.id = d.approved_by
    left join public.profiles xp on xp.id = d.cancelled_by
    left join public.lots lt on lt.id = d.lot_id
    left join public.profiles cp on cp.id = d.created_by`;

const AFFECTED_LOT_SELECT = `
  select al.id, al.nonconformance_id, al.lot_id, l.lot_number, l.status as lot_status, l.status_reason as lot_reason, al.quantity, al.note,
         (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'serialNumber', s.serial_number) order by s.serial_number), '[]'::jsonb)
            from public.serial_numbers s where s.id = any (al.serial_ids)) as serials,
         coalesce((select sum(d.quantity) from public.ncr_dispositions d where d.nonconformance_id = al.nonconformance_id and d.lot_id = al.lot_id and d.status = 'approved'), 0) as approved_quantity,
         coalesce((select sum(d.quantity) from public.ncr_dispositions d where d.nonconformance_id = al.nonconformance_id and d.lot_id = al.lot_id and d.status = 'proposed'), 0) as proposed_quantity,
         al.removed_at, al.removed_by, ${person('rp')} as removed_name, al.removed_reason, al.created_at, al.created_by, ${person('cp')} as created_name
    from public.ncr_affected_lots al
    join public.lots l on l.id = al.lot_id
    left join public.profiles rp on rp.id = al.removed_by
    left join public.profiles cp on cp.id = al.created_by`;

const toAffectedLot = (r: Row): AffectedLot => ({
  id: r.id as string,
  nonconformanceId: r.nonconformance_id as string,
  lot: { id: r.lot_id as string, lotNumber: r.lot_number as string, status: r.lot_status as string, statusReason: (r.lot_reason as string) ?? null },
  quantity: Number(r.quantity),
  serials: (r.serials as AffectedLot['serials']) ?? [],
  note: (r.note as string) ?? null,
  approvedQuantity: Number(r.approved_quantity),
  proposedQuantity: Number(r.proposed_quantity),
  removedAt: iso(r.removed_at),
  removedBy: ref(r.removed_by, r.removed_name),
  removedReason: (r.removed_reason as string) ?? null,
  createdAt: iso(r.created_at)!,
  createdBy: ref(r.created_by, r.created_name),
});

const toAction = (r: Row): ContainmentAction => ({
  id: r.id as string,
  nonconformanceId: r.nonconformance_id as string,
  kind: r.kind as ContainmentAction['kind'],
  description: r.description as string,
  owner: ref(r.owner_employee_id, r.owner_name),
  dueDate: (r.due_date as string) ?? null,
  quantityContained: num(r.quantity_contained),
  lot: r.lot_id ? { id: r.lot_id as string, lotNumber: r.lot_number as string } : null,
  status: r.status as ContainmentAction['status'],
  doneNote: (r.done_note as string) ?? null,
  doneAt: iso(r.done_at),
  doneBy: ref(r.done_by, r.done_name),
  cancelReason: (r.cancel_reason as string) ?? null,
  createdAt: iso(r.created_at)!,
  createdBy: ref(r.created_by, r.created_name),
});
const toDisposition = (r: Row): Disposition => ({
  id: r.id as string,
  nonconformanceId: r.nonconformance_id as string,
  decision: r.decision as Disposition['decision'],
  quantity: Number(r.quantity),
  instructions: r.instructions as string,
  reference: (r.reference as string) ?? null,
  lot: r.lot_id ? { id: r.lot_id as string, lotNumber: r.lot_number as string } : null,
  status: r.status as Disposition['status'],
  approvedAt: iso(r.approved_at),
  approvedBy: ref(r.approved_by, r.approved_name),
  approvalNote: (r.approval_note as string) ?? null,
  cancelledAt: iso(r.cancelled_at),
  cancelledBy: ref(r.cancelled_by, r.cancelled_name),
  cancelReason: (r.cancel_reason as string) ?? null,
  createdAt: iso(r.created_at)!,
  createdBy: ref(r.created_by, r.created_name),
});

/**
 * Containment and dispositions of a non-conformance. RLS (through the NC's site) decides what a person sees and changes; the database enforces the rules
 * (a done action needs a note, quantities never exceed the quantity affected, approval is a separate step with its own permission, stages are gated).
 */
@Injectable()
export class NcrWorkflowService {
  constructor(private readonly database: DatabaseService) {}

  // ---- containment ---------------------------------------------------------------------------

  containment(ctx: RequestContext, ncrId: string): Promise<Containment> {
    return this.database.asUser(ctx, async (db) => this.loadContainment(db, ctx, ncrId));
  }

  createAction(ctx: RequestContext, ncrId: string, body: z.infer<typeof CreateContainmentBody>): Promise<ContainmentAction> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertVisible(db, ctx, ncrId);
      const result = await db.execute<{ id: string }>(sql`
        insert into public.ncr_containment_actions (organisation_id, nonconformance_id, kind, description, owner_employee_id, due_date, quantity_contained, lot_id)
        values (${ctx.organisationId!}::uuid, ${ncrId}::uuid, ${body.kind}, ${body.description}, ${body.ownerEmployeeId ?? null}::uuid, ${body.dueDate ?? null}::date, ${body.quantityContained ?? null}::numeric, ${body.lotId ?? null}::uuid)
        returning id`);
      return this.loadAction(db, ctx, result.rows[0].id);
    });
  }

  updateAction(ctx: RequestContext, id: string, body: z.infer<typeof UpdateContainmentBody>): Promise<ContainmentAction> {
    const sets = Object.entries(body)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => sql`${sql.raw(CONTAINMENT_COLUMNS[k])} = ${v}`);
    return this.changeAction(ctx, id, sql.join(sets, sql`, `));
  }

  completeAction(ctx: RequestContext, id: string, body: z.infer<typeof CompleteContainmentBody>): Promise<ContainmentAction> {
    const qty = body.quantityContained === undefined ? sql`` : sql`, quantity_contained = ${body.quantityContained}`;
    return this.changeAction(ctx, id, sql`status = 'done', done_note = ${body.note}${qty}`);
  }

  reopenAction(ctx: RequestContext, id: string): Promise<ContainmentAction> {
    return this.changeAction(ctx, id, sql`status = 'open'`);
  }

  cancelAction(ctx: RequestContext, id: string, reason: string): Promise<ContainmentAction> {
    return this.changeAction(ctx, id, sql`status = 'cancelled', cancel_reason = ${reason}`);
  }

  /** Say why no containment is needed (or clear it with null). */
  setNotNeededReason(ctx: RequestContext, ncrId: string, reason: string | null): Promise<Containment> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertVisible(db, ctx, ncrId);
      await db.execute(sql`update public.nonconformances set containment_not_needed_reason = ${reason} where id = ${ncrId}::uuid and organisation_id = ${ctx.organisationId!}::uuid`);
      return this.loadContainment(db, ctx, ncrId);
    });
  }

  // ---- dispositions --------------------------------------------------------------------------

  dispositions(ctx: RequestContext, ncrId: string): Promise<Dispositions> {
    return this.database.asUser(ctx, async (db) => this.loadDispositions(db, ctx, ncrId));
  }

  createDisposition(ctx: RequestContext, ncrId: string, body: z.infer<typeof CreateDispositionBody>): Promise<Disposition> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertVisible(db, ctx, ncrId);
      const result = await db.execute<{ id: string }>(sql`
        insert into public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions, reference, lot_id)
        values (${ctx.organisationId!}::uuid, ${ncrId}::uuid, ${body.decision}, ${body.quantity}, ${body.instructions}, ${body.reference ?? null}, ${body.lotId ?? null}::uuid)
        returning id`);
      return this.loadDisposition(db, ctx, result.rows[0].id);
    });
  }

  updateDisposition(ctx: RequestContext, id: string, body: z.infer<typeof UpdateDispositionBody>): Promise<Disposition> {
    const sets = Object.entries(body)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => sql`${sql.raw(DISPOSITION_COLUMNS[k])} = ${v}`);
    return this.database.asUser(ctx, async (db) => {
      await this.loadDisposition(db, ctx, id);
      await db.execute(sql`update public.ncr_dispositions set ${sql.join(sets, sql`, `)} where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid`);
      return this.loadDisposition(db, ctx, id);
    });
  }

  approveDisposition(ctx: RequestContext, id: string, note?: string): Promise<Disposition> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadDisposition(db, ctx, id);
      await db.execute(sql`select app.approve_ncr_disposition(${id}::uuid, ${note ?? null})`);
      return this.loadDisposition(db, ctx, id);
    });
  }

  cancelDisposition(ctx: RequestContext, id: string, reason: string): Promise<Disposition> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadDisposition(db, ctx, id);
      await db.execute(sql`select app.cancel_ncr_disposition(${id}::uuid, ${reason})`);
      return this.loadDisposition(db, ctx, id);
    });
  }

  // ---- affected lots -------------------------------------------------------------------------

  affectedLots(ctx: RequestContext, ncrId: string): Promise<AffectedLots> {
    return this.database.asUser(ctx, async (db) => this.loadAffectedLots(db, ctx, ncrId));
  }

  addAffectedLot(ctx: RequestContext, ncrId: string, body: z.infer<typeof AddAffectedLotBody>): Promise<AffectedLot> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertVisible(db, ctx, ncrId);
      const serials = (body.serialIds ?? []).join(',');
      const result = await db.execute<{ id: string }>(sql`
        insert into public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity, serial_ids, note)
        values (${ctx.organisationId!}::uuid, ${ncrId}::uuid, ${body.lotId}::uuid, ${body.quantity}, string_to_array(${serials}, ',')::uuid[], ${body.note ?? null})
        returning id`);
      return this.loadAffectedLot(db, ctx, result.rows[0].id);
    });
  }

  updateAffectedLot(ctx: RequestContext, id: string, body: z.infer<typeof UpdateAffectedLotBody>): Promise<AffectedLot> {
    const sets = [
      ...(body.quantity !== undefined ? [sql`quantity = ${body.quantity}`] : []),
      ...(body.serialIds !== undefined ? [sql`serial_ids = string_to_array(${body.serialIds.join(',')}, ',')::uuid[]`] : []),
      ...(body.note !== undefined ? [sql`note = ${body.note}`] : []),
    ];
    return this.database.asUser(ctx, async (db) => {
      await this.loadAffectedLot(db, ctx, id);
      await db.execute(sql`update public.ncr_affected_lots set ${sql.join(sets, sql`, `)} where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid`);
      return this.loadAffectedLot(db, ctx, id);
    });
  }

  removeAffectedLot(ctx: RequestContext, id: string, reason: string): Promise<AffectedLot> {
    return this.changeAffectedLot(ctx, id, sql`removed_reason = ${reason}`);
  }

  restoreAffectedLot(ctx: RequestContext, id: string): Promise<AffectedLot> {
    return this.changeAffectedLot(ctx, id, sql`removed_reason = null`);
  }

  // ---- gates ---------------------------------------------------------------------------------

  gates(ctx: RequestContext, ncrId: string): Promise<Gates> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertVisible(db, ctx, ncrId);
      const result = await db.execute<Row>(sql`
        select app.ncr_gate_problems(${ncrId}::uuid, 'contained') as contained, app.ncr_gate_problems(${ncrId}::uuid, 'investigating') as investigating,
               app.ncr_gate_problems(${ncrId}::uuid, 'dispositioned') as dispositioned, app.ncr_gate_problems(${ncrId}::uuid, 'awaiting_closure') as awaiting_closure,
               app.ncr_gate_problems(${ncrId}::uuid, 'closed') as closed`);
      const r = result.rows[0];
      return { contained: r.contained as string[], investigating: r.investigating as string[], dispositioned: r.dispositioned as string[], awaitingClosure: r.awaiting_closure as string[], closed: r.closed as string[] };
    });
  }

  // ---- internals -----------------------------------------------------------------------------

  private async assertVisible(db: Db, ctx: RequestContext, ncrId: string) {
    const r = await db.execute<Row>(sql`select 1 from public.nonconformances where id = ${ncrId}::uuid and organisation_id = ${ctx.organisationId!}::uuid`);
    if (!r.rows.length) throw ApiError.notFound('ncr_not_found', 'Non-conformance not found');
  }

  private async loadContainment(db: Db, ctx: RequestContext, ncrId: string): Promise<Containment> {
    await this.assertVisible(db, ctx, ncrId);
    const rows = await db.execute<Row>(sql`${sql.raw(CONTAINMENT_SELECT)} where a.nonconformance_id = ${ncrId}::uuid order by a.created_at, a.id`);
    const n = await db.execute<Row>(sql`select containment_not_needed_reason as reason, app.ncr_gate_problems(${ncrId}::uuid, 'contained') as problems from public.nonconformances where id = ${ncrId}::uuid`);
    const problems = (n.rows[0].problems as string[]) ?? [];
    return { actions: rows.rows.map(toAction), notNeededReason: (n.rows[0].reason as string) ?? null, resolved: problems.length === 0, problems };
  }

  private async loadAction(db: Db, ctx: RequestContext, id: string): Promise<ContainmentAction> {
    const r = await db.execute<Row>(sql`${sql.raw(CONTAINMENT_SELECT)} where a.id = ${id}::uuid and a.organisation_id = ${ctx.organisationId!}::uuid`);
    if (!r.rows.length) throw ApiError.notFound('containment_action_not_found', 'Containment action not found');
    return toAction(r.rows[0]);
  }

  private changeAction(ctx: RequestContext, id: string, set: ReturnType<typeof sql>): Promise<ContainmentAction> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadAction(db, ctx, id);
      await db.execute(sql`update public.ncr_containment_actions set ${set} where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid`);
      return this.loadAction(db, ctx, id);
    });
  }

  private async loadDispositions(db: Db, ctx: RequestContext, ncrId: string): Promise<Dispositions> {
    await this.assertVisible(db, ctx, ncrId);
    const rows = await db.execute<Row>(sql`${sql.raw(DISPOSITION_SELECT)} where d.nonconformance_id = ${ncrId}::uuid order by d.created_at, d.id`);
    const n = await db.execute<Row>(sql`
      select n.quantity_affected, n.site_id, app.ncr_gate_problems(n.id, 'dispositioned') as problems,
             app.has_permission(n.organisation_id, 'ncr.approve_disposition', n.site_id) as can_approve
        from public.nonconformances n where n.id = ${ncrId}::uuid`);
    const data = rows.rows.map(toDisposition);
    const sum = (status: Disposition['status']) => data.filter((d) => d.status === status).reduce((t, d) => t + d.quantity, 0);
    const affected = num(n.rows[0].quantity_affected);
    const approvedQuantity = sum('approved');
    const proposedQuantity = sum('proposed');
    // Only the disposition part of the gate: containment is shown on its own card.
    const problems = ((n.rows[0].problems as string[]) ?? []).filter((p) => !p.includes('containment'));
    return { data, affected, approvedQuantity, proposedQuantity, remaining: Math.max(0, (affected ?? 0) - approvedQuantity - proposedQuantity), canApprove: n.rows[0].can_approve === true, settled: problems.length === 0, problems };
  }

  private changeAffectedLot(ctx: RequestContext, id: string, set: ReturnType<typeof sql>): Promise<AffectedLot> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadAffectedLot(db, ctx, id);
      await db.execute(sql`update public.ncr_affected_lots set ${set} where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid`);
      return this.loadAffectedLot(db, ctx, id);
    });
  }

  private async loadAffectedLot(db: Db, ctx: RequestContext, id: string): Promise<AffectedLot> {
    const r = await db.execute<Row>(sql`${sql.raw(AFFECTED_LOT_SELECT)} where al.id = ${id}::uuid and al.organisation_id = ${ctx.organisationId!}::uuid`);
    if (!r.rows.length) throw ApiError.notFound('affected_lot_not_found', 'Affected lot not found');
    return toAffectedLot(r.rows[0]);
  }

  private async loadAffectedLots(db: Db, ctx: RequestContext, ncrId: string): Promise<AffectedLots> {
    await this.assertVisible(db, ctx, ncrId);
    const rows = await db.execute<Row>(sql`${sql.raw(AFFECTED_LOT_SELECT)} where al.nonconformance_id = ${ncrId}::uuid order by al.removed_at is not null, l.lot_number, al.id`);
    const n = await db.execute<Row>(sql`
      select n.quantity_affected, n.lot_id, l.lot_number, app.ncr_gate_problems(n.id, 'dispositioned') as problems
        from public.nonconformances n left join public.lots l on l.id = n.lot_id where n.id = ${ncrId}::uuid`);
    const data = rows.rows.map(toAffectedLot);
    const live = data.filter((a) => !a.removedAt);
    const affected = num(n.rows[0].quantity_affected);
    const assigned = live.reduce((t, a) => t + a.quantity, 0);
    const own = n.rows[0].lot_id as string | null;
    return {
      data,
      affected,
      assigned,
      remaining: Math.max(0, (affected ?? 0) - assigned),
      suggestedLot: own && !live.some((a) => a.lot.id === own) ? { id: own, lotNumber: n.rows[0].lot_number as string } : null,
      problems: ((n.rows[0].problems as string[]) ?? []).filter((p) => p.startsWith('lot ')),
    };
  }

  private async loadDisposition(db: Db, ctx: RequestContext, id: string): Promise<Disposition> {
    const r = await db.execute<Row>(sql`${sql.raw(DISPOSITION_SELECT)} where d.id = ${id}::uuid and d.organisation_id = ${ctx.organisationId!}::uuid`);
    if (!r.rows.length) throw ApiError.notFound('disposition_not_found', 'Disposition not found');
    return toDisposition(r.rows[0]);
  }
}
