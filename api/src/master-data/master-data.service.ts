import { Injectable } from '@nestjs/common';
import { and, asc, eq, SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { decodeCursor, Page, toPage } from '../common/pagination';
import type { RequestContext } from '../common/request-context';
import { Row, personName } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import { customers, partRevisions, parts, suppliers, units } from '../database/schema';
import {
  AddPartCustomerBody,
  CreatePartBody,
  CreatePartyBody,
  CorrectionBody,
  CorrectionImpact,
  CreateRevisionBody,
  Party,
  PartDetail,
  PartListQuery,
  PartRevision,
  PartSummary,
  PartyListQuery,
  UpdatePartBody,
  UpdatePartCustomerBody,
  UpdatePartyBody,
  UpdateRevisionBody,
  Unit,
} from './master-data.schemas';

type PartyTable = typeof customers | typeof suppliers;
export type PartyKind = 'customer' | 'supplier';
const tableFor = (kind: PartyKind): PartyTable => (kind === 'customer' ? customers : suppliers);

const partyColumns = (t: PartyTable) => ({
  id: t.id,
  code: t.code,
  name: t.name,
  displayName: t.displayName,
  companyNumber: t.companyNumber,
  vatNumber: t.vatNumber,
  notes: t.notes,
  active: t.active,
});

const revisionColumns = {
  id: partRevisions.id,
  partId: partRevisions.partId,
  revision: partRevisions.revision,
  drawingRef: partRevisions.drawingRef,
  changeSummary: partRevisions.changeSummary,
  status: partRevisions.status,
  releasedAt: partRevisions.releasedAt,
  createdAt: partRevisions.createdAt,
  version: partRevisions.version,
  correctsId: partRevisions.correctsId,
  correctionReason: partRevisions.correctionReason,
  correctedAt: partRevisions.correctedAt,
};

const toRevision = (r: {
  id: string;
  partId: string;
  revision: string;
  drawingRef: string | null;
  changeSummary: string | null;
  status: string;
  releasedAt: Date | null;
  createdAt: Date;
  version: number;
  correctsId: string | null;
  correctionReason: string | null;
  correctedAt: Date | null;
}): PartRevision => ({
  ...r,
  status: r.status as PartRevision['status'],
  releasedAt: r.releasedAt ? r.releasedAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(),
  correctedAt: r.correctedAt ? r.correctedAt.toISOString() : null,
});

/** `%term%` for ILIKE with the pattern characters escaped. */
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Master data of the current organisation: units (global), customers, suppliers, parts and part
 * revisions. RLS makes other organisations' rows invisible (so their ids answer 404); the
 * database enforces the revision lifecycle (only drafts are editable, releasing supersedes the
 * previous released revision and writes an outbox event).
 */
@Injectable()
export class MasterDataService {
  constructor(private readonly database: DatabaseService) {}

  listUnits(ctx: RequestContext): Promise<Unit[]> {
    return this.database.asUser(ctx, (db) =>
      db.select({ code: units.code, name: units.name, quantityKind: units.quantityKind }).from(units).orderBy(asc(units.sortOrder), asc(units.code)),
    );
  }

  // ---- customers / suppliers -------------------------------------------------------------

  listParties(ctx: RequestContext, kind: PartyKind, q: z.infer<typeof PartyListQuery>): Promise<Page<Party>> {
    const t = tableFor(kind);
    const cursor = decodeCursor(q.cursor);
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [eq(t.organisationId, ctx.organisationId!)];
      if (!q.includeInactive) where.push(eq(t.active, true));
      if (q.q) where.push(sql`(${t.code} ilike ${likePattern(q.q)} or ${t.name} ilike ${likePattern(q.q)} or ${t.displayName} ilike ${likePattern(q.q)})`);
      if (cursor) where.push(sql`(${t.code}, ${t.id}) > (${cursor.k}, ${cursor.id}::uuid)`);
      const rows = await db.select(partyColumns(t)).from(t).where(and(...where)).orderBy(asc(t.code), asc(t.id)).limit(q.limit + 1);
      return toPage(rows, q.limit, (r) => ({ k: r.code, id: r.id }));
    });
  }

  createParty(ctx: RequestContext, kind: PartyKind, body: z.infer<typeof CreatePartyBody>): Promise<Party> {
    const t = tableFor(kind);
    return this.database.asUser(ctx, async (db) => {
      const [row] = await db
        .insert(t)
        .values({ organisationId: ctx.organisationId!, ...body })
        .returning(partyColumns(t));
      return row;
    });
  }

  updateParty(ctx: RequestContext, kind: PartyKind, id: string, body: z.infer<typeof UpdatePartyBody>): Promise<Party> {
    const t = tableFor(kind);
    return this.database.asUser(ctx, async (db) => {
      const [row] = await db
        .update(t)
        .set(body)
        .where(and(eq(t.id, id), eq(t.organisationId, ctx.organisationId!)))
        .returning(partyColumns(t));
      if (!row) throw ApiError.notFound(`${kind}_not_found`, `${kind === 'customer' ? 'Customer' : 'Supplier'} not found`);
      return row;
    });
  }

  // ---- parts -------------------------------------------------------------------------------

  listParts(ctx: RequestContext, q: z.infer<typeof PartListQuery>): Promise<Page<PartSummary>> {
    const cursor = decodeCursor(q.cursor);
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`p.organisation_id = ${ctx.organisationId!}::uuid`];
      if (!q.includeInactive) where.push(sql`p.active`);
      if (q.customerId) where.push(sql`exists (select 1 from public.part_customers pc where pc.part_id = p.id and pc.customer_id = ${q.customerId}::uuid)`);
      if (q.partFamilyId) where.push(sql`p.part_family_id = ${q.partFamilyId}::uuid`);
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(p.part_number ilike ${like} or p.name ilike ${like}
          or exists (select 1 from public.part_customers pc where pc.part_id = p.id and pc.customer_part_number ilike ${like}))`);
      }
      if (cursor) where.push(sql`(upper(p.part_number), p.id) > (${cursor.k}, ${cursor.id}::uuid)`);
      const rows = await this.selectParts(db, sql.join(where, sql` and `), q.limit + 1);
      return toPage(rows, q.limit, (r) => ({ k: r.partNumber.toUpperCase(), id: r.id }));
    });
  }

  getPart(ctx: RequestContext, id: string): Promise<PartDetail> {
    return this.database.asUser(ctx, (db) => this.loadPart(db, ctx, id));
  }

  createPart(ctx: RequestContext, body: z.infer<typeof CreatePartBody>): Promise<PartDetail> {
    return this.database.asUser(ctx, async (db) => {
      const { initialRevision, customerId, ...fields } = body;
      const [part] = await db
        .insert(parts)
        .values({ organisationId: ctx.organisationId!, ...fields })
        .returning({ id: parts.id });
      if (customerId) {
        await db.execute(sql`insert into public.part_customers (organisation_id, part_id, customer_id)
          values (${ctx.organisationId!}::uuid, ${part.id}::uuid, ${customerId}::uuid)`);
      }
      if (initialRevision) {
        await db.insert(partRevisions).values({ organisationId: ctx.organisationId!, partId: part.id, ...initialRevision });
      }
      return this.loadPart(db, ctx, part.id);
    });
  }

  updatePart(ctx: RequestContext, id: string, body: z.infer<typeof UpdatePartBody>): Promise<PartDetail> {
    return this.database.asUser(ctx, async (db) => {
      const [row] = await db
        .update(parts)
        .set(body)
        .where(and(eq(parts.id, id), eq(parts.organisationId, ctx.organisationId!)))
        .returning({ id: parts.id });
      if (!row) throw ApiError.notFound('part_not_found', 'Part not found');
      return this.loadPart(db, ctx, id);
    });
  }

  // ---- revisions ---------------------------------------------------------------------------

  createRevision(ctx: RequestContext, partId: string, body: z.infer<typeof CreateRevisionBody>): Promise<PartRevision> {
    return this.database.asUser(ctx, async (db) => {
      const [part] = await db
        .select({ id: parts.id })
        .from(parts)
        .where(and(eq(parts.id, partId), eq(parts.organisationId, ctx.organisationId!)));
      if (!part) throw ApiError.notFound('part_not_found', 'Part not found');
      const [row] = await db
        .insert(partRevisions)
        .values({ organisationId: ctx.organisationId!, partId, ...body })
        .returning(revisionColumns);
      return toRevision(row);
    });
  }

  updateRevision(ctx: RequestContext, id: string, body: z.infer<typeof UpdateRevisionBody>): Promise<PartRevision> {
    return this.changeRevision(ctx, id, body);
  }

  /**
   * release: draft → released (supersedes the previous one); obsolete: retire any revision. A draft that is a correction is released through
   * app.release_part_revision_correction (needs approval rights; the wrong version becomes `corrected` in the same transaction).
   */
  transitionRevision(ctx: RequestContext, id: string, to: 'released' | 'obsolete'): Promise<PartRevision> {
    if (to !== 'released') return this.changeRevision(ctx, id, { status: to });
    return this.database.asUser(ctx, async (db) => {
      const [row] = await db
        .select({ correctsId: partRevisions.correctsId })
        .from(partRevisions)
        .where(and(eq(partRevisions.id, id), eq(partRevisions.organisationId, ctx.organisationId!)));
      if (!row) throw ApiError.notFound('revision_not_found', 'Revision not found');
      if (!row.correctsId) {
        const [released] = await db.update(partRevisions).set({ status: 'released' }).where(eq(partRevisions.id, id)).returning(revisionColumns);
        return toRevision(released);
      }
      await db.execute(sql`select app.release_part_revision_correction(${id}::uuid)`);
      const [released] = await db.select(revisionColumns).from(partRevisions).where(eq(partRevisions.id, id));
      return toRevision(released);
    });
  }

  /** Start a correction of the current released revision: a draft of its next version with the same letter, values copied. */
  startCorrection(ctx: RequestContext, id: string, body: z.infer<typeof CorrectionBody>): Promise<PartRevision> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute<{ id: string }>(sql`select app.start_part_revision_correction(${id}::uuid, ${body.reason}) as id`);
      const [row] = await db.select(revisionColumns).from(partRevisions).where(eq(partRevisions.id, result.rows[0].id));
      return toRevision(row);
    });
  }

  /**
   * What ran on the version a correction replaces. Asked about the correction (draft or released) or about the corrected version itself.
   * People see only what they may read: the flags say whether the lists are complete or hidden.
   */
  correctionImpact(ctx: RequestContext, id: string): Promise<CorrectionImpact> {
    return this.database.asUser(ctx, async (db) => {
      const org = ctx.organisationId!;
      const found = await db.execute<Row>(sql`
        select r.id, r.revision, r.version, r.status, r.corrects_id, r.correction_reason,
               o.id as o_id, o.revision as o_revision, o.version as o_version, o.status as o_status
          from public.part_revisions r left join public.part_revisions o on o.id = r.corrects_id
         where r.id = ${id}::uuid and r.organisation_id = ${org}::uuid`);
      const r = found.rows[0];
      if (!r) throw ApiError.notFound('revision_not_found', 'Revision not found');
      // The version in question: the one this corrects, or itself when it is the corrected one (which is replaced by a later version).
      let target: { id: string; revision: string; version: number; status: string };
      let correction: CorrectionImpact['correction'] = null;
      if (r.corrects_id) {
        target = { id: r.o_id as string, revision: r.o_revision as string, version: Number(r.o_version), status: r.o_status as string };
        correction = { id: r.id as string, version: Number(r.version), status: r.status as string as PartRevision['status'], reason: (r.correction_reason as string) ?? null };
      } else if (r.status === 'corrected') {
        target = { id: r.id as string, revision: r.revision as string, version: Number(r.version), status: 'corrected' };
        const c = (await db.execute<Row>(sql`select id, version, status, correction_reason from public.part_revisions where corrects_id = ${id}::uuid order by version desc limit 1`)).rows[0];
        if (c) correction = { id: c.id as string, version: Number(c.version), status: c.status as string as PartRevision['status'], reason: (c.correction_reason as string) ?? null };
      } else {
        throw ApiError.badRequest('not_a_correction', 'This revision has no correction');
      }
      const can = (await db.execute<{ insp: boolean; ncr: boolean }>(sql`
        select app.has_permission(${org}::uuid, 'inspection.read') as insp, app.has_permission(${org}::uuid, 'ncr.read') as ncr`)).rows[0];
      const inspections = can.insp
        ? await db.execute<Row>(sql`
            select i.id, i.reference, i.status, i.result, i.started_at, i.operation_code, ${sql.raw(personName('pr'))} as by_name, count(*) over ()::int as total
              from public.inspection_records i left join public.profiles pr on pr.id = i.created_by
             where i.organisation_id = ${org}::uuid and i.part_revision_id = ${target.id}::uuid
             order by (i.status = 'in_progress') desc, i.started_at desc limit 50`)
        : { rows: [] as Row[] };
      const ncrs = can.ncr
        ? await db.execute<Row>(sql`
            select n.id, n.reference, n.stage, n.source, n.title, to_char(n.detected_at, 'YYYY-MM-DD') as detected_at, count(*) over ()::int as total
              from public.nonconformances n
             where n.organisation_id = ${org}::uuid and n.part_revision_id = ${target.id}::uuid and n.deleted_at is null
             order by n.detected_at desc, n.reference desc limit 50`)
        : { rows: [] as Row[] };
      return {
        corrected: { ...target, status: target.status as PartRevision['status'] },
        correction,
        canReadInspections: can.insp,
        canReadNcrs: can.ncr,
        inspectionsTotal: Number(inspections.rows[0]?.total ?? 0),
        inspections: inspections.rows.map((x) => ({
          id: x.id as string,
          reference: x.reference as string,
          status: x.status as string,
          result: (x.result as string) ?? null,
          startedAt: new Date(x.started_at as string).toISOString(),
          startedBy: (x.by_name as string) ?? null,
          operationCode: (x.operation_code as string) ?? null,
        })),
        ncrsTotal: Number(ncrs.rows[0]?.total ?? 0),
        ncrs: ncrs.rows.map((x) => ({ id: x.id as string, reference: x.reference as string, stage: x.stage as string, source: x.source as string, title: x.title as string, detectedAt: x.detected_at as string })),
      };
    });
  }

  private changeRevision(ctx: RequestContext, id: string, set: Partial<typeof partRevisions.$inferInsert>): Promise<PartRevision> {
    return this.database.asUser(ctx, async (db) => {
      const [row] = await db
        .update(partRevisions)
        .set(set)
        .where(and(eq(partRevisions.id, id), eq(partRevisions.organisationId, ctx.organisationId!)))
        .returning(revisionColumns);
      if (!row) throw ApiError.notFound('revision_not_found', 'Revision not found');
      return toRevision(row);
    });
  }

  // ---- loading -----------------------------------------------------------------------------

  private async selectParts(db: Db, where: SQL, limit: number): Promise<PartSummary[]> {
    const result = await db.execute<{
      id: string;
      part_number: string;
      name: string;
      description: string | null;
      active: boolean;
      customer_id: string | null;
      customer_code: string | null;
      customer_name: string | null;
      family_id: string | null;
      family_code: string | null;
      family_name: string | null;
      current_revision: string | null;
      current_version: number | null;
    }>(sql`
      select p.id, p.part_number, p.name, p.description, p.active,
             c.id as customer_id, c.code as customer_code, coalesce(c.display_name, c.name) as customer_name,
             f.id as family_id, f.code as family_code, f.name as family_name,
             (select r.revision from public.part_revisions r where r.part_id = p.id and r.status = 'released') as current_revision,
             (select r.version from public.part_revisions r where r.part_id = p.id and r.status = 'released') as current_version
      from public.parts p
      left join public.part_customers ppc on ppc.part_id = p.id and ppc.is_primary
      left join public.customers c on c.id = ppc.customer_id
      left join public.part_families f on f.id = p.part_family_id
      where ${where}
      order by upper(p.part_number), p.id
      limit ${limit}`);
    return result.rows.map((r) => ({
      id: r.id,
      partNumber: r.part_number,
      name: r.name,
      description: r.description,
      active: r.active,
      customer: r.customer_id ? { id: r.customer_id, code: r.customer_code!, name: r.customer_name! } : null,
      partFamily: r.family_id ? { id: r.family_id, code: r.family_code!, name: r.family_name! } : null,
      currentRevision: r.current_revision,
      currentVersion: r.current_version,
    }));
  }

  private async loadPart(db: Db, ctx: RequestContext, id: string): Promise<PartDetail> {
    const [part] = await this.selectParts(db, sql`p.organisation_id = ${ctx.organisationId!}::uuid and p.id = ${id}::uuid`, 1);
    if (!part) throw ApiError.notFound('part_not_found', 'Part not found');
    const revisions = await db
      .select(revisionColumns)
      .from(partRevisions)
      .where(eq(partRevisions.partId, id))
      .orderBy(sql`${partRevisions.createdAt} desc`, sql`${partRevisions.revision} desc`);
    const links = await db.execute<{ id: string; customer_id: string; code: string; name: string; customer_part_number: string | null; is_primary: boolean }>(sql`
      select pc.id, pc.customer_id, c.code, coalesce(c.display_name, c.name) as name, pc.customer_part_number, pc.is_primary
      from public.part_customers pc join public.customers c on c.id = pc.customer_id
      where pc.part_id = ${id}::uuid order by pc.is_primary desc, upper(c.code)`);
    return {
      ...part,
      revisions: revisions.map(toRevision),
      customers: links.rows.map((l) => ({
        id: l.id,
        customer: { id: l.customer_id, code: l.code, name: l.name },
        customerPartNumber: l.customer_part_number,
        isPrimary: l.is_primary,
      })),
    };
  }

  // ---- part customers ------------------------------------------------------------------------

  /** Adds a customer to a part (the first one becomes primary). */
  addPartCustomer(ctx: RequestContext, partId: string, body: z.infer<typeof AddPartCustomerBody>): Promise<PartDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadPart(db, ctx, partId); // 404 when not visible
      await db.execute(sql`insert into public.part_customers (organisation_id, part_id, customer_id, customer_part_number, is_primary)
        values (${ctx.organisationId!}::uuid, ${partId}::uuid, ${body.customerId}::uuid, ${body.customerPartNumber ?? null}, ${body.isPrimary ?? false})`);
      return this.loadPart(db, ctx, partId);
    });
  }

  /** Changes the customer's part number, or makes this customer the primary one. */
  updatePartCustomer(ctx: RequestContext, id: string, body: z.infer<typeof UpdatePartCustomerBody>): Promise<PartDetail> {
    return this.database.asUser(ctx, async (db) => {
      const set = [
        ...(body.customerPartNumber !== undefined ? [sql`customer_part_number = ${body.customerPartNumber}`] : []),
        ...(body.isPrimary ? [sql`is_primary = true`] : []),
      ];
      const result = await db.execute<{ part_id: string }>(sql`update public.part_customers set ${sql.join(set, sql`, `)}
        where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid returning part_id`);
      if (!result.rows.length) throw ApiError.notFound('part_customer_not_found', 'Customer link not found');
      return this.loadPart(db, ctx, result.rows[0].part_id);
    });
  }

  /** Removes a customer from a part (another one becomes primary if needed). */
  removePartCustomer(ctx: RequestContext, id: string): Promise<PartDetail> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute<{ part_id: string }>(sql`delete from public.part_customers
        where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid returning part_id`);
      if (!result.rows.length) throw ApiError.notFound('part_customer_not_found', 'Customer link not found');
      return this.loadPart(db, ctx, result.rows[0].part_id);
    });
  }
}
