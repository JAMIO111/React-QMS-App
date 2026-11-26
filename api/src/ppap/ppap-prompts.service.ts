import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { todayIn } from '../supplier-quality/expiry';
import { attentionFor, customerState, PackageRow, PartCustomer, sourceApplies, sourcePrompts, SourceKind, SourcePart } from './ppap-prompts';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const revisionLabel = (letter: unknown, version: unknown) => (letter ? `${letter as string}${Number(version) > 1 ? ` v${Number(version)}` : ''}` : null);

/** A customer requires PPAP when the organisation has recorded rules for them or has ever sent them a package. */
const REQUIRES = sql`(exists (select 1 from public.ppap_customer_rules r where r.customer_id = c.id and r.organisation_id = c.organisation_id)
                      or exists (select 1 from public.ppap_submissions s where s.customer_id = c.id and s.organisation_id = c.organisation_id and s.direction = 'submitted'))`;

/** Packages sent to customers that were not withdrawn and that no later package replaced. */
const LIVE_SUBMITTED = sql`s.direction = 'submitted' and s.status <> 'withdrawn'
  and not exists (select 1 from public.ppap_submissions r where r.replaces_id = s.id and r.organisation_id = s.organisation_id and r.status <> 'withdrawn')`;

const INTERIM = sql`(select d.expires_on::text from public.ppap_decisions d where d.submission_id = s.id and d.kind = 'interim_approved' order by d.seq desc limit 1)`;

/**
 * The PPAP state of a part, and the prompts a change or a control plan revision gives (PP13, PP14). Read as the caller, so row-level security decides what is seen. INFORMATION ONLY.
 */
@Injectable()
export class PpapPromptsService {
  constructor(private readonly database: DatabaseService) {}

  private async can(db: Parameters<Parameters<DatabaseService['asUser']>[1]>[0], ctx: RequestContext, permission: string) {
    return Boolean((await db.execute<Row>(sql`select app.has_permission(${orgOf(ctx)}::uuid, ${permission}) as ok`)).rows[0]?.ok);
  }

  /** Where a part's revision stands for each of its customers, and what is worth saying about it. `available: false` without `ppap.read`. */
  partState(ctx: RequestContext, partId: string, revisionId?: string) {
    return this.database.asUser(ctx, async (db) => {
      if (!(await this.can(db, ctx, 'ppap.read'))) return { available: false as const };
      const org = orgOf(ctx);
      const today = todayIn(ctx.timeZone);
      const part = (await db.execute<Row>(sql`select id, part_number, name from public.parts where id = ${partId}::uuid and organisation_id = ${org}::uuid`)).rows[0];
      if (!part) throw ApiError.notFound('part_not_found', 'Part not found');
      const rev = (
        await db.execute<Row>(
          revisionId
            ? sql`select id, revision, version, status from public.part_revisions where id = ${revisionId}::uuid and part_id = ${partId}::uuid and organisation_id = ${org}::uuid`
            : sql`select id, revision, version, status from public.part_revisions where part_id = ${partId}::uuid and organisation_id = ${org}::uuid and status = 'released' limit 1`
        )
      ).rows[0];
      if (revisionId && !rev) throw ApiError.notFound('revision_not_found', 'Revision not found');
      const customers = (
        await db.execute<Row>(sql`
          select c.id, c.name, c.code, pc.is_primary, ${REQUIRES} as requires
            from public.part_customers pc join public.customers c on c.id = pc.customer_id
           where pc.part_id = ${partId}::uuid and pc.organisation_id = ${org}::uuid order by pc.is_primary desc, c.name`)
      ).rows;
      const packages: PackageRow[] = (
        await db.execute<Row>(sql`
          select s.id, s.reference, s.customer_id, s.part_revision_id, s.status, s.created_at::text as created_at, s.next_review_on::text as next_review, ${INTERIM} as interim_expires_on
            from public.ppap_submissions s where s.organisation_id = ${org}::uuid and s.part_id = ${partId}::uuid and ${LIVE_SUBMITTED}`)
      ).rows.map((r) => ({
        id: r.id as string, reference: r.reference as string, customerId: r.customer_id as string, partRevisionId: r.part_revision_id as string, status: r.status as string,
        createdAt: r.created_at as string, interimExpiresOn: (r.interim_expires_on as string) ?? null, nextReviewOn: (r.next_review as string) ?? null,
      }));
      const last = (await db.execute<Row>(sql`select max(created_at)::date::text as d from public.production_orders where part_id = ${partId}::uuid and organisation_id = ${org}::uuid and status <> 'cancelled'`)).rows[0];
      const lastProducedOn = (last?.d as string) ?? null;
      const label = rev ? revisionLabel(rev.revision, rev.version) : null;
      const byCustomer: PartCustomer[] = customers.map((c) => ({
        id: c.id as string, name: c.name as string, requires: Boolean(c.requires), ...customerState(packages.filter((p) => p.customerId === c.id), (rev?.id as string) ?? null, today),
      }));
      return {
        available: true as const,
        part: { id: part.id as string, partNumber: part.part_number as string, name: part.name as string },
        revision: rev ? { id: rev.id as string, label, status: rev.status as string } : null,
        customers: byCustomer.map((c, i) => ({ ...c, code: customers[i].code as string, primary: Boolean(customers[i].is_primary) })),
        attention: rev ? attentionFor({ partNumber: part.part_number as string, revisionLabel: label, today, lastProducedOn, customers: byCustomer }) : [],
        lastProducedOn,
        canRaise: await this.can(db, ctx, 'ppap.manage'),
      };
    });
  }

  /** The PPAPs raised from a change or a control plan revision, and the new ones it may call for. `applies` says whether its own state calls for a prompt at all. */
  sourcePrompts(ctx: RequestContext, kind: SourceKind, id: string) {
    return this.database.asUser(ctx, async (db) => {
      if (!(await this.can(db, ctx, 'ppap.read'))) return { available: false as const };
      const org = orgOf(ctx);
      let reference: string;
      let applies: boolean;
      if (kind === 'change') {
        const c = (
          await db.execute<Row>(sql`select c.reference, c.stage, t.key as type_key from public.change_requests c left join public.change_types t on t.id = c.type_id where c.id = ${id}::uuid and c.organisation_id = ${org}::uuid`)
        ).rows[0];
        if (!c) throw ApiError.notFound('change_not_found', 'Change not found');
        reference = c.reference as string;
        applies = sourceApplies('change', { stage: c.stage as string, typeKey: (c.type_key as string) ?? null });
      } else {
        const r = (
          await db.execute<Row>(sql`select p.plan_code, r.revision_code, r.status from public.control_plan_revisions r join public.control_plans p on p.id = r.control_plan_id where r.id = ${id}::uuid and r.organisation_id = ${org}::uuid`)
        ).rows[0];
        if (!r) throw ApiError.notFound('control_plan_revision_not_found', 'Control plan revision not found');
        reference = `${r.plan_code as string} rev ${r.revision_code as string}`;
        applies = sourceApplies('control_plan_revision', { status: r.status as string });
      }
      const raised = (
        await db.execute<Row>(sql`
          select s.id, s.reference, s.status, s.part_id, s.customer_id, p.part_number, c.name as customer_name
            from public.ppap_submissions s join public.parts p on p.id = s.part_id left join public.customers c on c.id = s.customer_id
           where s.organisation_id = ${org}::uuid and s.origin_kind = ${kind} and s.origin_id = ${id}::uuid order by s.created_at`)
      ).rows;
      const partIds = (await db.execute<Row>(sql`select unnest(app.ppap_source_parts(${kind}, ${id}::uuid)) as id`)).rows.map((r) => r.id as string);
      const parts: SourcePart[] = [];
      for (const pid of partIds) {
        const p = (await db.execute<Row>(sql`select id, part_number, name from public.parts where id = ${pid}::uuid and organisation_id = ${org}::uuid`)).rows[0];
        if (!p) continue;
        const cs = (
          await db.execute<Row>(sql`
            select c.id, c.name, ${REQUIRES} as requires from public.part_customers pc join public.customers c on c.id = pc.customer_id
             where pc.part_id = ${pid}::uuid and pc.organisation_id = ${org}::uuid order by pc.is_primary desc, c.name`)
        ).rows;
        parts.push({
          id: p.id as string, partNumber: p.part_number as string, name: p.name as string,
          customers: cs.map((c) => {
            const r = raised.find((x) => x.part_id === pid && x.customer_id === c.id && x.status !== 'withdrawn');
            return { id: c.id as string, name: c.name as string, requires: Boolean(c.requires), raised: r ? { id: r.id as string, reference: r.reference as string, status: r.status as string } : null };
          }),
        });
      }
      return {
        available: true as const,
        applies,
        reference,
        prompts: applies ? sourcePrompts(kind, reference, parts) : [],
        raised: raised.map((r) => ({
          id: r.id as string, reference: r.reference as string, status: r.status as string,
          part: { id: r.part_id as string, partNumber: r.part_number as string }, customer: r.customer_id ? { id: r.customer_id as string, name: r.customer_name as string } : null,
        })),
        canRaise: await this.can(db, ctx, 'ppap.manage'),
      };
    });
  }

  /** What the record suggests for a PPAP raised from it. Nothing is saved. */
  draft(ctx: RequestContext, kind: string, id: string) {
    return this.database.asUser(ctx, async (db) => (await db.execute<Row>(sql`select app.ppap_draft_from(${kind}, ${id}::uuid) as r`)).rows[0].r as Record<string, unknown>);
  }
}
