import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { DEFAULT_DAYS, EvidenceMode, modeEvidence, NcCount, NcExample, notForeseen } from './fmea-evidence';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
/** Live non-conformances that were really raised: not a draft, not cancelled, not deleted. */
const RAISED = sql`n.deleted_at is null and n.stage not in ('draft', 'cancelled')`;

/**
 * FMEA (FM5b): what the non-conformance register says about the failure modes of an analysis (the living FMEA, plan FM12). Read as the caller, so row-level security decides which
 * non-conformances they see; a caller who may not read non-conformances at all is told the evidence is not available, never that nothing happened. Information only.
 */
@Injectable()
export class FmeaEvidenceService {
  constructor(private readonly database: DatabaseService) {}

  evidence(ctx: RequestContext, revisionId: string, days: number = DEFAULT_DAYS) {
    const org = orgOf(ctx);
    return this.database.asUser(ctx, async (db) => {
      const rev = (
        await db.execute<Row>(sql`select v.id, v.status, v.letter, f.id as fmea_id, f.number, f.title from public.fmea_revisions v join public.fmeas f on f.id = v.fmea_id
                                   where v.id = ${revisionId}::uuid and v.organisation_id = ${org}::uuid`)
      ).rows[0];
      if (!rev) throw ApiError.notFound('fmea_revision_not_found', 'Revision not found');
      const revision = { id: rev.id as string, status: rev.status as string, letter: (rev.letter as string) ?? null, fmeaId: rev.fmea_id as string, number: rev.number as string, title: rev.title as string };

      const allowed = (await db.execute<Row>(sql`select app.has_permission_somewhere(${org}::uuid, 'ncr.read') as ok`)).rows[0]?.ok === true;
      if (!allowed) return { available: false as const, reason: 'You cannot read non-conformances, so there is nothing to compare the analysis with.', revision, days };

      const [modes, causes, scope] = await Promise.all([
        db.execute<Row>(sql`select m.id, m.text, m.ncr_failure_mode_id, i.name as item_name from public.fmea_failure_modes m
                              join public.fmea_functions fn on fn.id = m.function_id join public.fmea_items i on i.id = fn.item_id
                             where m.revision_id = ${revisionId}::uuid and m.organisation_id = ${org}::uuid order by i.position, fn.position, m.position`),
        db.execute<Row>(sql`select failure_mode_id, occurrence from public.fmea_causes where revision_id = ${revisionId}::uuid and organisation_id = ${org}::uuid and occurrence is not null`),
        db.execute<Row>(sql`select kind, coalesce(part_id, part_family_id, machine_id)::text as id from public.fmea_links
                             where revision_id = ${revisionId}::uuid and organisation_id = ${org}::uuid and kind in ('part', 'part_family', 'machine')`),
      ]);
      const scopeOf = (kind: string) => scope.rows.filter((r) => r.kind === kind).map((r) => r.id as string);
      const scoped = scope.rows.length > 0;
      // Lists go to SQL as one text value, never a JS array.
      const partIds = scopeOf('part').join(',');
      const familyIds = scopeOf('part_family').join(',');
      const machineIds = scopeOf('machine').join(',');
      const inScope = scoped
        ? sql`(n.part_id = any(string_to_array(${partIds}, ',')::uuid[])
               or n.part_id in (select p.id from public.parts p where p.part_family_id = any(string_to_array(${familyIds}, ',')::uuid[]))
               or n.causal_process_id = any(string_to_array(${machineIds}, ',')::uuid[])
               or n.detection_process_id = any(string_to_array(${machineIds}, ',')::uuid[]))`
        : sql`true`;
      const since = sql`n.detected_at >= current_date - ${days}::int`;

      const occurrences = new Map<string, number[]>();
      for (const c of causes.rows) occurrences.set(c.failure_mode_id as string, [...(occurrences.get(c.failure_mode_id as string) ?? []), Number(c.occurrence)]);
      const evidenceModes: EvidenceMode[] = modes.rows.map((m) => ({
        id: m.id as string, text: m.text as string, itemName: m.item_name as string, ncFailureModeId: (m.ncr_failure_mode_id as string) ?? null, occurrences: occurrences.get(m.id as string) ?? [],
      }));
      const tied = new Set(evidenceModes.map((m) => m.ncFailureModeId).filter((v): v is string => v != null));

      const countsQ = await db.execute<Row>(sql`
        select n.failure_mode_id as id, c.name, count(*)::int as total, (count(*) filter (where ${inScope}))::int as in_scope,
               (max(n.detected_at) filter (where ${inScope}))::text as latest
          from public.nonconformances n join public.ncr_classifications c on c.id = n.failure_mode_id
         where n.organisation_id = ${org}::uuid and ${RAISED} and n.failure_mode_id is not null and ${since}
         group by n.failure_mode_id, c.name`);
      const counts: NcCount[] = countsQ.rows.map((r) => ({ ncFailureModeId: r.id as string, name: r.name as string, total: Number(r.total), inScope: Number(r.in_scope), latestOn: (r.latest as string) ?? null }));

      let unforeseen: { available: true; groups: ReturnType<typeof notForeseen>; unclassified: number } | { available: false; reason: string };
      if (!scoped) {
        unforeseen = { available: false, reason: 'Name a part, a part family or a machine in the FMEA\'s scope to see which non-conformances it did not foresee: without one, every failure mode in the register would count.' };
      } else {
        const tiedList = [...tied].join(',');
        const [examples, unclassified] = await Promise.all([
          db.execute<Row>(sql`
            select n.id, n.reference, n.title, n.detected_at::text as detected_on, n.failure_mode_id
              from public.nonconformances n
             where n.organisation_id = ${org}::uuid and ${RAISED} and n.failure_mode_id is not null and ${since} and ${inScope}
               and not (n.failure_mode_id = any(string_to_array(${tiedList}, ',')::uuid[]))
             order by n.detected_at desc, n.reference limit 300`),
          db.execute<Row>(sql`select count(*)::int as n from public.nonconformances n
                               where n.organisation_id = ${org}::uuid and ${RAISED} and n.failure_mode_id is null and ${since} and ${inScope}`),
        ]);
        const sample: NcExample[] = examples.rows.map((e) => ({
          id: e.id as string, reference: e.reference as string, title: e.title as string, detectedOn: e.detected_on as string, ncFailureModeId: e.failure_mode_id as string,
        }));
        unforeseen = { available: true, groups: notForeseen(counts, tied, sample), unclassified: Number(unclassified.rows[0]?.n ?? 0) };
      }

      const rows = modeEvidence(evidenceModes, counts, scoped);
      return {
        available: true as const,
        revision,
        days,
        scoped,
        modes: rows,
        notForeseen: unforeseen,
        totals: {
          failureModes: rows.length,
          tied: rows.filter((r) => r.tied).length,
          withNonConformances: rows.filter((r) => (r.count ?? 0) > 0).length,
          toLookAt: rows.filter((r) => r.flag === 'seen_but_rated_low').length,
        },
      };
    });
  }
}
