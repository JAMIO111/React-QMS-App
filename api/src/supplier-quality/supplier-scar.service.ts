import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import {
  AcknowledgeScarBody, AWAITING_RESPONSE, CreateScarBody, DecideExtensionBody, ExtendBody, ImplementationBody, LinkNcrBody, RecordResponseBody, ReviewBody, ScarDetail, ScarItemInput, ScarListQuery, ScarPage,
  ScarPeople, ScarPeopleQuery, ScarReasonBody, ScarRow, UpdateScarBody, VerificationBody,
} from './supplier-scar.schemas';
import { z } from 'zod';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown user' } : null);
const date = (v: unknown) => (v ? (v as string).slice(0, 10) : null);
const itemJson = (i: ScarItemInput) => ({ partId: i.partId ?? null, material: i.material ?? null, lotId: i.lotId ?? null, receiptReference: i.receiptReference ?? null, quantity: i.quantity ?? null, notes: i.notes ?? null });
const notFound = () => ApiError.notFound('supplier_scar_not_found', 'SCAR not found');

const SORT_SQL: Record<ScarListQuery['sort'], string> = {
  reference: 'c.reference',
  title: 'lower(c.title)',
  supplier: 'lower(s.name)',
  status: `array_position(array['draft','issued','acknowledged','response_received','under_review','revision_requested','accepted','verifying','closed','cancelled'], c.status)`,
  severity: `array_position(array['critical','major','minor'], c.severity)`,
  responseDueOn: 'c.response_due_on',
  ncrCount: `(select count(*) from public.supplier_scar_ncrs l where l.scar_id = c.id and l.ended_at is null)`,
  createdAt: 'c.created_at',
  issuedAt: 'c.issued_at',
};

const AWAITING_SQL = `c.status in (${AWAITING_RESPONSE.map((s) => `'${s}'`).join(',')})`;
const OVERDUE_SQL = `(${AWAITING_SQL} and c.response_due_on < current_date)`;

const LIST_COLUMNS = sql.raw(`
  c.id, c.reference, c.title, c.severity, c.status, c.owner_user_id, ${personName('po')} as owner_name, c.response_due_on::text as response_due_on, c.issued_at, c.closed_at, c.created_at,
  s.id as supplier_id, s.code as supplier_code, s.name as supplier_name,
  ${OVERDUE_SQL} as overdue, case when ${OVERDUE_SQL} then (current_date - c.response_due_on) else 0 end as days_overdue,
  (select count(*)::int from public.supplier_scar_ncrs l where l.scar_id = c.id and l.ended_at is null) as ncr_count,
  (select count(*)::int from public.supplier_scar_responses r where r.scar_id = c.id) as response_count`);

const toRow = (r: Row): ScarRow => ({
  id: r.id as string,
  reference: r.reference as string,
  title: r.title as string,
  supplier: { id: r.supplier_id as string, code: r.supplier_code as string, name: r.supplier_name as string },
  severity: r.severity as ScarRow['severity'],
  status: r.status as ScarRow['status'],
  owner: person(r.owner_user_id, r.owner_name),
  responseDueOn: date(r.response_due_on),
  overdue: !!r.overdue,
  daysOverdue: Number(r.days_overdue ?? 0),
  ncrCount: Number(r.ncr_count ?? 0),
  responseCount: Number(r.response_count ?? 0),
  issuedAt: iso(r.issued_at),
  closedAt: iso(r.closed_at),
  createdAt: iso(r.created_at)!,
});

/**
 * Supplier corrective action requests (SQ3). Every write is a database function that checks the tenant, the permission and the status transition; this service shapes the answers and
 * keeps the stages (response, review, implementation, verification) as separate lists. Overdue is worked out here and in SQL when read, never stored.
 */
@Injectable()
export class SupplierScarService {
  constructor(private readonly database: DatabaseService) {}

  // ---- register ------------------------------------------------------------------------------------

  list(ctx: RequestContext, q: ScarListQuery): Promise<z.infer<typeof ScarPage>> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`c.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.status === 'running') where.push(sql`c.status not in ('closed', 'cancelled')`);
      else if (q.status !== 'all') where.push(sql`c.status = any(string_to_array(${q.status}, ','))`);
      if (q.severity) where.push(sql`c.severity = any(string_to_array(${q.severity}, ','))`);
      if (q.supplierId) where.push(sql`c.supplier_id = ${q.supplierId}::uuid`);
      if (q.ncrId) where.push(sql`exists (select 1 from public.supplier_scar_ncrs l where l.scar_id = c.id and l.ncr_id = ${q.ncrId}::uuid and l.ended_at is null)`);
      if (q.overdue) where.push(sql.raw(OVERDUE_SQL));
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(c.reference ilike ${like} or c.title ilike ${like} or c.problem_description ilike ${like} or s.name ilike ${like} or s.code ilike ${like}
          or exists (select 1 from public.supplier_scar_ncrs l join public.nonconformances n on n.id = l.ncr_id where l.scar_id = c.id and l.ended_at is null and (n.reference ilike ${like} or n.title ilike ${like})))`);
      }
      const clause = sql.join(where, sql` and `);
      const order = sql.raw(`${SORT_SQL[q.sort]} ${q.order} nulls last, c.reference desc`);
      const rows = await db.execute<Row>(sql`
        select ${LIST_COLUMNS} from public.supplier_scars c join public.suppliers s on s.id = c.supplier_id left join public.profiles po on po.id = c.owner_user_id
        where ${clause} order by ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      const count = await db.execute<{ n: number }>(sql`select count(*)::int as n from public.supplier_scars c join public.suppliers s on s.id = c.supplier_id where ${clause}`);
      return { data: rows.rows.map(toRow), page: q.page, pageSize: q.pageSize, total: Number(count.rows[0].n) };
    });
  }

  // ---- one SCAR ------------------------------------------------------------------------------------

  get(ctx: RequestContext, id: string): Promise<ScarDetail> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  private async load(db: Db, ctx: RequestContext, id: string): Promise<ScarDetail> {
    const head = await db.execute<Row>(sql`
      select ${LIST_COLUMNS}, c.problem_description, c.requirement_breached, c.objective_evidence, c.containment_requirements, c.original_response_due_on::text as original_response_due_on, c.issued_by, c.acknowledged_at, c.acknowledged_by, c.acknowledged_note,
             c.closed_by, c.cancelled_at, c.cancelled_by, c.cancel_reason, c.created_by,
             k.id as contact_id, k.name as contact_name, k.email as contact_email, cp.id as capa_id, cp.reference as capa_reference, cp.title as capa_title,
             ${sql.raw(personName('pi'))} as issued_by_name, ${sql.raw(personName('pa'))} as acknowledged_by_name, ${sql.raw(personName('pcl'))} as closed_by_name,
             ${sql.raw(personName('pca'))} as cancelled_by_name, ${sql.raw(personName('pcr'))} as created_by_name
      from public.supplier_scars c join public.suppliers s on s.id = c.supplier_id left join public.profiles po on po.id = c.owner_user_id
      left join public.supplier_contacts k on k.id = c.contact_id left join public.capas cp on cp.id = c.capa_id
      left join public.profiles pi on pi.id = c.issued_by left join public.profiles pa on pa.id = c.acknowledged_by left join public.profiles pcl on pcl.id = c.closed_by
      left join public.profiles pca on pca.id = c.cancelled_by left join public.profiles pcr on pcr.id = c.created_by
      where c.id = ${id}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid`);
    const h = head.rows[0];
    if (!h) throw notFound();

    const canApprove = (await db.execute<{ ok: boolean }>(sql`select app.has_permission(${orgOf(ctx)}::uuid, 'supplier_quality.approve') as ok`)).rows[0].ok;
    const [ncrs, responses, implementations, verifications, extensions, history, items] = await Promise.all([
      db.execute<Row>(sql`
        select l.id as link_id, l.linked_at, l.ended_at, l.end_reason, n.id, n.reference, n.title, n.stage, n.severity
        from public.supplier_scar_ncrs l join public.nonconformances n on n.id = l.ncr_id where l.scar_id = ${id}::uuid order by (l.ended_at is not null), l.linked_at`),
      db.execute<Row>(sql`
        select r.*, k.name as contact_name, ${sql.raw(personName('pr'))} as received_by_name,
               v.id as review_id, v.decision, v.note as review_note, v.reviewed_at, v.reviewed_by, ${sql.raw(personName('pv'))} as reviewed_by_name
        from public.supplier_scar_responses r left join public.supplier_contacts k on k.id = r.contact_id left join public.profiles pr on pr.id = r.received_by
        left join public.supplier_scar_reviews v on v.response_id = r.id left join public.profiles pv on pv.id = v.reviewed_by
        where r.scar_id = ${id}::uuid order by r.seq`),
      db.execute<Row>(sql`select i.*, ${sql.raw(personName('p'))} as recorded_by_name from public.supplier_scar_implementations i left join public.profiles p on p.id = i.recorded_by where i.scar_id = ${id}::uuid order by i.recorded_at`),
      db.execute<Row>(sql`select v.*, ${sql.raw(personName('p'))} as verified_by_name from public.supplier_scar_verifications v left join public.profiles p on p.id = v.verified_by where v.scar_id = ${id}::uuid order by v.verified_at`),
      db.execute<Row>(sql`select e.*, e.previous_due_on::text as prev_due, e.new_due_on::text as new_due, ${sql.raw(personName('p'))} as extended_by_name, ${sql.raw(personName('pd'))} as decided_by_name
        from public.supplier_scar_extensions e left join public.profiles p on p.id = e.extended_by left join public.profiles pd on pd.id = e.decided_by where e.scar_id = ${id}::uuid order by e.extended_at`),
      db.execute<Row>(sql`select x.*, ${sql.raw(personName('p'))} as changed_by_name from public.supplier_scar_status_history x left join public.profiles p on p.id = x.changed_by where x.scar_id = ${id}::uuid order by x.changed_at`),
      db.execute<Row>(sql`
        select i.*, pt.part_number, pt.name as part_name, l.lot_number from public.supplier_scar_items i left join public.parts pt on pt.id = i.part_id left join public.lots l on l.id = i.lot_id
        where i.scar_id = ${id}::uuid order by (i.ended_at is not null), i.created_at`),
    ]);

    return {
      ...toRow(h),
      problemDescription: (h.problem_description as string) ?? null,
      requirementBreached: (h.requirement_breached as string) ?? null,
      objectiveEvidence: (h.objective_evidence as string) ?? null,
      containmentRequirements: (h.containment_requirements as string) ?? null,
      items: items.rows.map((r) => ({
        id: r.id as string,
        part: r.part_id ? { id: r.part_id as string, partNumber: r.part_number as string, name: r.part_name as string } : null,
        material: (r.material as string) ?? null,
        lot: r.lot_id ? { id: r.lot_id as string, lotNumber: r.lot_number as string } : null,
        receiptReference: (r.receipt_reference as string) ?? null,
        quantity: r.quantity === null || r.quantity === undefined ? null : Number(r.quantity),
        notes: (r.notes as string) ?? null,
        addedAt: iso(r.created_at)!,
        endedAt: iso(r.ended_at),
        endReason: (r.end_reason as string) ?? null,
      })),
      originalResponseDueOn: date(h.original_response_due_on),
      contact: h.contact_id ? { id: h.contact_id as string, name: h.contact_name as string, email: (h.contact_email as string) ?? null } : null,
      capa: h.capa_id ? { id: h.capa_id as string, reference: h.capa_reference as string, title: (h.capa_title as string) ?? null } : null,
      issuedBy: person(h.issued_by, h.issued_by_name),
      acknowledgedAt: iso(h.acknowledged_at),
      acknowledgedBy: person(h.acknowledged_by, h.acknowledged_by_name),
      acknowledgedNote: (h.acknowledged_note as string) ?? null,
      closedBy: person(h.closed_by, h.closed_by_name),
      cancelledAt: iso(h.cancelled_at),
      cancelledBy: person(h.cancelled_by, h.cancelled_by_name),
      cancelReason: (h.cancel_reason as string) ?? null,
      createdBy: person(h.created_by, h.created_by_name),
      ncrs: ncrs.rows.map((r) => ({
        linkId: r.link_id as string,
        ncr: { id: r.id as string, reference: r.reference as string, title: r.title as string, stage: r.stage as string, severity: (r.severity as string) ?? null },
        linkedAt: iso(r.linked_at)!,
        endedAt: iso(r.ended_at),
        endReason: (r.end_reason as string) ?? null,
      })),
      responses: responses.rows.map((r) => ({
        id: r.id as string,
        seq: Number(r.seq),
        rootCause: r.root_cause as string,
        containment: (r.containment as string) ?? null,
        correctiveAction: r.corrective_action as string,
        preventiveAction: (r.preventive_action as string) ?? null,
        plannedCompletionOn: date(r.planned_completion_on),
        respondedOn: date(r.responded_on)!,
        respondedByName: (r.responded_by_name as string) ?? null,
        extentOfCondition: (r.extent_of_condition as string) ?? null,
        escapePoint: (r.escape_point as string) ?? null,
        responsibleName: (r.responsible_name as string) ?? null,
        rootCauseMethod: (r.root_cause_method as 'five_whys' | 'fishbone' | 'other') ?? null,
        contact: r.contact_id ? { id: r.contact_id as string, name: r.contact_name as string } : null,
        receivedAt: iso(r.received_at)!,
        receivedBy: person(r.received_by, r.received_by_name),
        review: r.review_id
          ? { id: r.review_id as string, decision: r.decision as 'accepted' | 'revision_requested', note: r.review_note as string, reviewedAt: iso(r.reviewed_at)!, reviewedBy: person(r.reviewed_by, r.reviewed_by_name) }
          : null,
      })),
      implementations: implementations.rows.map((r) => ({ id: r.id as string, description: r.description as string, implementedOn: date(r.implemented_on)!, evidenceNote: (r.evidence_note as string) ?? null, recordedAt: iso(r.recorded_at)!, recordedBy: person(r.recorded_by, r.recorded_by_name) })),
      verifications: verifications.rows.map((r) => ({ id: r.id as string, result: r.result as 'effective' | 'not_effective', method: r.method as string, note: r.note as string, verifiedAt: iso(r.verified_at)!, verifiedBy: person(r.verified_by, r.verified_by_name) })),
      extensions: extensions.rows.map((r) => ({
        id: r.id as string,
        previousDueOn: date(r.prev_due)!,
        newDueOn: date(r.new_due)!,
        reason: r.reason as string,
        extendedAt: iso(r.extended_at)!,
        extendedBy: person(r.extended_by, r.extended_by_name),
        status: r.status as 'pending' | 'approved' | 'rejected' | 'withdrawn',
        decidedAt: iso(r.decided_at),
        decidedBy: person(r.decided_by, r.decided_by_name),
        decisionNote: (r.decision_note as string) ?? null,
        canDecide: r.status === 'pending' && canApprove && r.extended_by !== ctx.user.id,
      })),
      history: history.rows.map((r) => ({ id: r.id as string, fromStatus: (r.from_status as ScarDetail['status']) ?? null, toStatus: r.to_status as ScarDetail['status'], reason: (r.reason as string) ?? null, changedAt: iso(r.changed_at)!, changedBy: person(r.changed_by, r.changed_by_name) })),
    };
  }

  // ---- commands (each answers with the whole SCAR) -------------------------------------------------

  /** Runs one database function as the caller, then answers with the SCAR as it now is. Unknown ids are answered before the function runs. */
  private async command(ctx: RequestContext, id: string, run: (db: Db) => Promise<unknown>): Promise<ScarDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      await run(db);
      return this.load(db, ctx, id);
    });
  }

  create(ctx: RequestContext, b: CreateScarBody): Promise<ScarDetail> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ r: { id: string; created: boolean } }>(sql`
        select app.create_supplier_scar(${b.supplierId}::uuid, ${b.title}, ${b.problemDescription ?? null}, ${b.severity}, ${b.responseDueOn ?? null}::date, ${b.contactId ?? null}::uuid,
          ${sql.raw(`array[${b.ncrIds.map((n) => `'${n}'`).join(',')}]::uuid[]`)}, ${b.capaId ?? null}::uuid, ${b.clientKey ?? null},
          ${JSON.stringify({ requirementBreached: b.requirementBreached ?? null, objectiveEvidence: b.objectiveEvidence ?? null, containmentRequirements: b.containmentRequirements ?? null, ownerId: b.ownerId ?? null, items: b.items.map(itemJson) })}::jsonb) as r`);
      return this.load(db, ctx, res.rows[0].r.id);
    });
  }

  update(ctx: RequestContext, id: string, b: UpdateScarBody) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.update_supplier_scar(${id}::uuid, ${JSON.stringify(b)}::jsonb)`));
  }
  issue(ctx: RequestContext, id: string) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.issue_supplier_scar(${id}::uuid)`));
  }
  acknowledge(ctx: RequestContext, id: string, b: AcknowledgeScarBody) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.acknowledge_supplier_scar(${id}::uuid, ${b.note ?? null})`));
  }
  recordResponse(ctx: RequestContext, id: string, b: RecordResponseBody) {
    return this.command(ctx, id, (db) =>
      db.execute(sql`select app.record_scar_response(${id}::uuid, ${b.rootCause}, ${b.containment ?? null}, ${b.correctiveAction}, ${b.preventiveAction ?? null}, ${b.plannedCompletionOn ?? null}::date,
        ${b.respondedOn}::date, ${b.respondedByName ?? null}, ${b.contactId ?? null}::uuid, ${b.extentOfCondition ?? null}, ${b.escapePoint ?? null}, ${b.responsibleName ?? null}, ${b.rootCauseMethod ?? null})`));
  }
  startReview(ctx: RequestContext, id: string) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.start_scar_review(${id}::uuid)`));
  }
  review(ctx: RequestContext, id: string, b: ReviewBody) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.review_scar_response(${id}::uuid, ${b.decision}, ${b.note})`));
  }
  recordImplementation(ctx: RequestContext, id: string, b: ImplementationBody) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.record_scar_implementation(${id}::uuid, ${b.description}, ${b.implementedOn}::date, ${b.evidenceNote ?? null})`));
  }
  recordVerification(ctx: RequestContext, id: string, b: VerificationBody) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.record_scar_verification(${id}::uuid, ${b.result}, ${b.method}, ${b.note})`));
  }
  extend(ctx: RequestContext, id: string, b: ExtendBody) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.request_scar_extension(${id}::uuid, ${b.newDueOn}::date, ${b.reason})`));
  }
  addItem(ctx: RequestContext, id: string, b: ScarItemInput) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.add_scar_item(${id}::uuid, ${JSON.stringify(itemJson(b))}::jsonb)`));
  }

  /** Runs a command named by a child record (an item or an extension) and answers with the SCAR it belongs to. */
  private async viaChild(ctx: RequestContext, table: 'supplier_scar_items' | 'supplier_scar_extensions', childId: string, notFoundCode: string, run: (db: Db) => Promise<unknown>): Promise<ScarDetail> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ scar_id: string }>(sql`select scar_id from public.${sql.raw(table)} where id = ${childId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (res.rows.length === 0) throw ApiError.notFound(notFoundCode, 'Not found');
      await run(db);
      return this.load(db, ctx, res.rows[0].scar_id);
    });
  }
  removeItem(ctx: RequestContext, itemId: string, b: ScarReasonBody) {
    return this.viaChild(ctx, 'supplier_scar_items', itemId, 'supplier_scar_item_not_found', (db) => db.execute(sql`select app.remove_scar_item(${itemId}::uuid, ${b.reason})`));
  }
  decideExtension(ctx: RequestContext, extensionId: string, b: DecideExtensionBody) {
    return this.viaChild(ctx, 'supplier_scar_extensions', extensionId, 'supplier_scar_extension_not_found', (db) => db.execute(sql`select app.decide_scar_extension(${extensionId}::uuid, ${b.approve}, ${b.note})`));
  }
  withdrawExtension(ctx: RequestContext, extensionId: string, b: ScarReasonBody) {
    return this.viaChild(ctx, 'supplier_scar_extensions', extensionId, 'supplier_scar_extension_not_found', (db) => db.execute(sql`select app.withdraw_scar_extension(${extensionId}::uuid, ${b.reason})`));
  }

  /** Active members for the internal-owner picker (the members list itself needs members.read). */
  people(ctx: RequestContext, q: ScarPeopleQuery): Promise<z.infer<typeof ScarPeople>> {
    return this.database.asUser(ctx, async (db) => {
      const like = q.q ? likePattern(q.q) : null;
      const res = await db.execute<Row>(sql`
        select m.user_id, coalesce(${sql.raw(personName('p'))}, m.invited_email, 'Unknown') as name
        from public.organisation_users m left join public.profiles p on p.id = m.user_id
        where m.organisation_id = ${orgOf(ctx)}::uuid and m.status = 'active' and m.user_id is not null
          and (${like}::text is null or ${sql.raw(personName('p'))} ilike ${like} or m.invited_email ilike ${like})
        order by name limit 100`);
      return { data: res.rows.map((r) => ({ userId: r.user_id as string, name: r.name as string })) };
    });
  }
  cancel(ctx: RequestContext, id: string, b: ScarReasonBody) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.cancel_supplier_scar(${id}::uuid, ${b.reason})`));
  }
  linkNcr(ctx: RequestContext, id: string, b: LinkNcrBody) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.link_scar_ncr(${id}::uuid, ${b.ncrId}::uuid)`));
  }

  /** Ends one NC link (with a reason) and answers with the SCAR it belonged to. */
  async unlinkNcr(ctx: RequestContext, linkId: string, b: ScarReasonBody): Promise<ScarDetail> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ scar_id: string }>(sql`select scar_id from public.supplier_scar_ncrs where id = ${linkId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (res.rows.length === 0) throw ApiError.notFound('supplier_scar_link_not_found', 'Link not found');
      await db.execute(sql`select app.unlink_scar_ncr(${linkId}::uuid, ${b.reason})`);
      return this.load(db, ctx, res.rows[0].scar_id);
    });
  }
}
