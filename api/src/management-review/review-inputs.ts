import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditsDashboardService } from '../audits/audits-dashboard';
import { CalibrationDashboardService } from '../calibration/calibration-dashboard';
import { personName, Row } from '../calibration/calibration.service';
import type { RequestContext } from '../common/request-context';
import { CompetenceDashboardService } from '../competence/competence-dashboard';
import { DatabaseService } from '../database/database.service';
import { NcrDashboardService } from '../ncr/ncr-dashboard';
import { ProcessControlDashboardService } from '../process-control/process-control-dashboard';
import { RiskDashboardService } from '../risk/risk-dashboard';
import { SupplierDashboardService } from '../supplier-quality/supplier-dashboard';
import { QualityObjectivesService } from './quality-objectives.service';

/**
 * A gathered input section, in one shape the review page draws whatever the source: figures (a label, a value, an optional unit and note) and lists
 * (a title and items, each with an optional value, note and in-app link). Stored frozen in management_review_inputs.snapshot.
 */
export interface Figure {
  label: string;
  value: number | string | null;
  unit?: string;
  note?: string;
}
export interface ListItem {
  label: string;
  value?: number | string | null;
  note?: string;
  link?: string;
}
export interface Snapshot {
  figures: Figure[];
  lists: { title: string; items: ListItem[] }[];
  /** Parts of the section the person could not read (the rest was gathered). */
  notes?: string[];
}
type Gathered = { available: boolean; snapshot: Snapshot | null };

/** Sections and what each needs to be read (organisation-wide unless `anyScope`). Commentary-only sections are not gathered. */
export const DATA_SECTIONS = [
  'previous_actions', 'customer_feedback', 'quality_objectives', 'process_performance', 'nonconformities', 'monitoring', 'audit_results', 'external_providers', 'resources', 'risks',
] as const;
export type DataSection = (typeof DATA_SECTIONS)[number];

const pct = (v: number | null | undefined) => (v == null ? null : v);
const top = <T>(items: T[], n = 8) => items.slice(0, n);
const counted = (rows: { label: string; count: number }[]) => rows.filter((r) => r.count > 0).map((r) => ({ label: r.label, value: r.count }));

/**
 * Gathers the management review's input sections for a period from each module's own dashboard, AS THE PERSON (each dashboard reads under their RLS).
 * A section whose source the person may not read is "not available", never zeros; a section with several sources keeps what was readable and says what was not.
 */
@Injectable()
export class ReviewInputsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly ncr: NcrDashboardService,
    private readonly calibration: CalibrationDashboardService,
    private readonly processControl: ProcessControlDashboardService,
    private readonly audits: AuditsDashboardService,
    private readonly suppliers: SupplierDashboardService,
    private readonly competence: CompetenceDashboardService,
    private readonly risks: RiskDashboardService,
    private readonly objectives: QualityObjectivesService,
  ) {}

  /** Which of these permissions the caller holds (organisation-wide, or at any site for the `anyScope` ones). */
  private async held(ctx: RequestContext): Promise<Set<string>> {
    const org = ctx.organisationId!;
    const rows = await this.database.asUser(ctx, (db) =>
      db.execute<Row>(sql`
        select p from unnest(${'{audits.read,supplier_quality.read,competence.read,risk.read,capa.read,management_review.read}'}::text[]) p where app.has_permission(${org}::uuid, p)
        union all
        select p from unnest(${'{ncr.read,calibration.read,process_control.read}'}::text[]) p where app.has_permission_somewhere(${org}::uuid, p)`),
    );
    return new Set(rows.rows.map((r) => r.p as string));
  }

  async gather(ctx: RequestContext, reviewId: string, from: string, to: string, sections: DataSection[]): Promise<Map<DataSection, Gathered>> {
    const can = await this.held(ctx);
    const period = { from, to };
    const out = new Map<DataSection, Gathered>();
    const none: Gathered = { available: false, snapshot: null };
    for (const section of sections) {
      switch (section) {
        case 'previous_actions':
          out.set(section, can.has('management_review.read') ? { available: true, snapshot: await this.previousActions(ctx, reviewId, from, to) } : none);
          break;
        case 'customer_feedback': {
          if (!can.has('ncr.read')) {
            out.set(section, none);
            break;
          }
          const d = await this.ncr.get(ctx, { source: ['customer'], ...period });
          out.set(section, {
            available: true,
            snapshot: {
              figures: [
                { label: 'Customer non-conformances raised', value: d.kpis.raised, note: `${d.kpis.raisedPrevious} in the period before` },
                { label: 'Customer non-conformances open', value: d.kpis.open, note: `${d.kpis.criticalOpen} critical` },
                { label: 'Cost', value: d.kpis.cost, unit: d.baseCurrency },
              ],
              lists: [
                { title: 'By category', items: counted(d.byCategory) },
                { title: 'Open, by stage', items: counted(d.byStage) },
              ],
            },
          });
          break;
        }
        case 'quality_objectives': {
          if (!can.has('management_review.read')) {
            out.set(section, none);
            break;
          }
          const list = await this.objectives.list(ctx, false);
          const by = (s: string) => list.data.filter((o) => o.standing === s).length;
          out.set(section, {
            available: true,
            snapshot: {
              figures: [
                { label: 'On target', value: by('on_target') },
                { label: 'Off target', value: by('off_target') },
                { label: 'No value yet', value: by('no_value') },
              ],
              lists: [
                {
                  title: 'Objectives',
                  items: list.data.map((o) => ({
                    label: `${o.reference} · ${o.title}`,
                    value: o.available && o.latest ? o.latest.value : null,
                    note: `${o.available ? (o.latest ? `${o.latest.label}${o.latest.current ? ' so far' : ''}, ` : '') : 'not available, '}target ${o.direction === 'at_most' ? 'at most' : 'at least'} ${o.target}${o.unit ? ` ${o.unit}` : ''} · ${o.standing.replace('_', ' ')}`,
                    link: `/Management-Review/Objectives/${o.id}`,
                  })),
                },
              ],
            },
          });
          break;
        }
        case 'process_performance': {
          const notes: string[] = [];
          const figures: Figure[] = [];
          const lists: Snapshot['lists'] = [];
          if (can.has('ncr.read')) {
            const d = await this.ncr.get(ctx, { source: [], ...period });
            figures.push({ label: 'Non-conformances raised', value: d.kpis.raised, note: `${d.kpis.raisedPrevious} in the period before` }, { label: 'Cost of non-conformance', value: d.kpis.cost, unit: d.baseCurrency });
            lists.push({ title: 'Raised, by where they came from', items: counted(d.bySource) }, { title: 'Parts with the most', items: top(d.topParts).map((p) => ({ label: `${p.partNumber} · ${p.name}`, value: p.count, link: `/Parts/${p.id}` })) });
          } else notes.push('Non-conformances are not available to you');
          if (can.has('process_control.read')) {
            const d = await this.processControl.get(ctx, period);
            figures.push(
              { label: 'Inspections', value: d.kpis.inspections, note: `${d.kpis.inspectionsPrevious} in the period before` },
              { label: 'First-pass rate', value: pct(d.kpis.firstPassRate), unit: '%' },
              { label: 'Failed readings without action', value: d.kpis.openFailures },
            );
            lists.push({ title: 'Failures by characteristic', items: top(counted(d.failuresByCharacteristic)) });
          } else notes.push('Inspections are not available to you');
          out.set(section, figures.length ? { available: true, snapshot: { figures, lists, notes } } : none);
          break;
        }
        case 'nonconformities': {
          const notes: string[] = [];
          const figures: Figure[] = [];
          const lists: Snapshot['lists'] = [];
          if (can.has('ncr.read')) {
            const d = await this.ncr.get(ctx, { source: [], ...period });
            figures.push(
              { label: 'Raised', value: d.kpis.raised },
              { label: 'Closed', value: d.kpis.closed },
              { label: 'Open now', value: d.kpis.open, note: `${d.kpis.criticalOpen} critical` },
              { label: 'Average days to close', value: d.kpis.avgDaysToClose },
            );
            lists.push({ title: 'Raised, by category', items: counted(d.byCategory) }, { title: 'Open, by stage', items: counted(d.byStage) });
          } else notes.push('Non-conformances are not available to you');
          if (can.has('capa.read')) {
            const c = await this.capaFigures(ctx, from, to);
            figures.push(...c.figures);
            lists.push(...c.lists);
          } else notes.push('8Ds are not available to you');
          out.set(section, figures.length ? { available: true, snapshot: { figures, lists, notes } } : none);
          break;
        }
        case 'monitoring': {
          if (!can.has('calibration.read')) {
            out.set(section, none);
            break;
          }
          const d = await this.calibration.get(ctx, period);
          out.set(section, {
            available: true,
            snapshot: {
              figures: [
                { label: 'Gauges in use', value: d.kpis.inUse },
                { label: 'Overdue for calibration', value: d.kpis.overdue },
                { label: 'Compliance', value: pct(d.kpis.compliance), unit: '%', note: 'In-use gauges not overdue' },
                { label: 'Calibrations', value: d.kpis.calibrated, note: `${d.kpis.calibratedPrevious} in the period before` },
                { label: 'Failed', value: d.kpis.failed },
                { label: 'Passed first time', value: pct(d.kpis.firstTimePassRate), unit: '%' },
                { label: 'Quarantined', value: d.kpis.quarantined },
              ],
              lists: [{ title: 'Gauges needing attention', items: top(d.attention, 10).map((g) => ({ label: `${g.assetNumber} · ${g.description}`, note: g.nextDueOn ? `due ${g.nextDueOn}` : g.status, link: `/Calibration/Gauges/${g.id}` })) }],
            },
          });
          break;
        }
        case 'audit_results': {
          if (!can.has('audits.read')) {
            out.set(section, none);
            break;
          }
          const d = await this.audits.get(ctx, period);
          const k = d.kpis;
          out.set(section, {
            available: true,
            snapshot: {
              figures: [
                { label: 'Planned', value: k.planned },
                { label: 'Done', value: k.done, note: `${k.missed} missed` },
                { label: 'Completion', value: pct(k.completionRate), unit: '%' },
                { label: 'Pass rate', value: pct(k.passRate), unit: '%' },
                { label: 'Average score', value: pct(k.averageScore), unit: '%' },
                { label: 'Findings raised', value: k.findingsRaised, note: `${k.nonconformances} became a non-conformance` },
                { label: 'Findings open', value: k.openFindings, note: `${k.overdueFindings} overdue` },
              ],
              lists: [],
            },
          });
          break;
        }
        case 'external_providers': {
          if (!can.has('supplier_quality.read')) {
            out.set(section, none);
            break;
          }
          const d = await this.suppliers.get(ctx, period);
          const k = d.kpis;
          const notes: string[] = [];
          const figures: Figure[] = [
            { label: 'Suppliers in use', value: k.suppliers, note: `${k.approved} approved, ${k.pendingApproval} pending` },
            { label: 'High or critical risk', value: k.highRisk },
            { label: 'Corrective action requests running', value: k.openScars, note: `${k.overdueScars} with a response overdue` },
            { label: 'Certificates and documents expired', value: k.expired, note: `${k.expiring} expiring soon` },
          ];
          if (d.performance.available) {
            figures.push(
              { label: 'On-time delivery', value: pct(d.performance.otdPercent), unit: '%' },
              { label: 'PPM', value: d.performance.ppm, unit: 'PPM' },
              { label: 'In full', value: pct(d.performance.inFullPercent), unit: '%' },
            );
          } else notes.push('Deliveries and scoring are not available to you');
          if (d.ncs.available) figures.push({ label: 'Supplier non-conformances raised', value: d.ncs.raised, note: `${d.ncs.open} open` });
          else notes.push('Supplier non-conformances are not available to you');
          out.set(section, {
            available: true,
            snapshot: {
              figures,
              lists: d.performance.available
                ? [{ title: 'Suppliers needing attention', items: d.performance.attention.map((s) => ({ label: `${s.code} · ${s.name}`, value: s.score, note: `${s.band}${s.reason ? ` · ${s.reason}` : ''}`, link: `/Suppliers/${s.id}` })) }]
                : [],
              notes,
            },
          });
          break;
        }
        case 'resources': {
          if (!can.has('competence.read')) {
            out.set(section, none);
            break;
          }
          const d = await this.competence.get(ctx, period);
          const k = d.kpis;
          out.set(section, {
            available: true,
            snapshot: {
              figures: [
                { label: 'People with competence gaps', value: k.withGaps, note: `of ${k.withRequirements} with requirements; ${k.gaps} skills short` },
                { label: 'Assessments expired', value: k.expired, note: `${k.expiring30} expiring within 30 days` },
                { label: 'People never assessed', value: k.neverAssessed },
                { label: 'Training completed', value: k.completions, note: `${k.sessions} sessions, ${k.failures} failed` },
              ],
              lists: [{ title: 'Skills most short', items: d.gapsBySkill.map((s) => ({ label: `${s.code} · ${s.name}`, value: s.people, note: `of ${s.required} who need it` })) }],
            },
          });
          break;
        }
        case 'risks': {
          if (!can.has('risk.read')) {
            out.set(section, none);
            break;
          }
          const d = await this.risks.dashboard(ctx, period);
          const k = d.kpis;
          out.set(section, {
            available: true,
            snapshot: {
              figures: [
                { label: 'Live risks', value: k.risks, note: `${k.opportunities} opportunities` },
                { label: 'High or critical', value: k.highOrCritical, note: `${k.untreatedHigh} with no treatment` },
                { label: 'Reviews overdue', value: k.reviewsOverdue },
                { label: 'Actions open', value: k.openActions, note: `${k.overdueActions} overdue` },
                { label: 'Raised in the period', value: k.raised, note: `${k.raisedFromRecords} from a problem` },
                { label: 'Closed in the period', value: k.closed },
              ],
              lists: [
                { title: 'By level', items: d.byBand.filter((b) => b.count > 0).map((b) => ({ label: b.band === 'unassessed' ? 'Not assessed' : b.band[0].toUpperCase() + b.band.slice(1), value: b.count })) },
                { title: 'Highest risks', items: d.topRisks.map((r) => ({ label: `${r.reference} · ${r.title}`, value: r.score, note: `${r.band ?? 'not assessed'} · ${r.status}`, link: `/Risk/Register/${r.id}` })) },
              ],
            },
          });
          break;
        }
      }
    }
    return out;
  }

  /** Actions of earlier reviews (completed before this one) that are still open, or were closed in the period. */
  private async previousActions(ctx: RequestContext, reviewId: string, from: string, to: string): Promise<Snapshot> {
    const org = ctx.organisationId!;
    const rows = (
      await this.database.asUser(ctx, (db) =>
        db.execute<Row>(sql`
          select a.id, a.description, a.status, a.due_date::text as due, a.done_note, a.cancel_reason, m.reference, m.id as review_id,
                 ${sql.raw(personName('p'))} as owner_name, (a.status = 'open' and a.due_date < current_date) as overdue
            from public.management_review_actions a
            join public.management_reviews m on m.id = a.review_id
            left join public.profiles p on p.id = a.owner_user_id
           where a.organisation_id = ${org}::uuid and m.id <> ${reviewId}::uuid and m.status = 'completed'
             and (a.status = 'open' or coalesce(a.done_at, a.cancelled_at)::date between ${from}::date and ${to}::date)
           order by (a.status = 'open') desc, a.due_date nulls last, m.reference limit 100`),
      )
    ).rows;
    const status = (r: Row) => (r.status === 'open' ? (r.overdue ? 'open, overdue' : 'open') : r.status === 'done' ? 'done' : 'cancelled');
    return {
      figures: [
        { label: 'Still open', value: rows.filter((r) => r.status === 'open').length, note: `${rows.filter((r) => r.overdue).length} overdue` },
        { label: 'Done in the period', value: rows.filter((r) => r.status === 'done').length },
        { label: 'Cancelled in the period', value: rows.filter((r) => r.status === 'cancelled').length },
      ],
      lists: [
        {
          title: 'Actions',
          items: rows.map((r) => ({
            label: r.description as string,
            value: status(r),
            note: [r.reference, r.owner_name, r.due ? `due ${r.due}` : null, (r.done_note ?? r.cancel_reason) as string | null].filter(Boolean).join(' · '),
            link: `/Management-Review/Reviews/${r.review_id}`,
          })),
        },
      ],
    };
  }

  /** 8Ds: running by stage, closed in the period, verified effective, overdue actions. */
  private async capaFigures(ctx: RequestContext, from: string, to: string) {
    const org = ctx.organisationId!;
    const k = (
      await this.database.asUser(ctx, (db) =>
        db.execute<Row>(sql`
          select count(*) filter (where c.stage not in ('closed', 'cancelled'))::int as running,
                 count(*) filter (where c.stage = 'closed' and c.closed_at::date between ${from}::date and ${to}::date)::int as closed,
                 count(*) filter (where c.stage = 'closed' and c.closed_at::date between ${from}::date and ${to}::date and c.closed_at::date <= coalesce(c.due_date, c.closed_at::date))::int as on_time,
                 count(*) filter (where c.created_at::date between ${from}::date and ${to}::date)::int as started,
                 (select count(*)::int from public.capa_actions a join public.capas x on x.id = a.capa_id
                   where x.organisation_id = ${org}::uuid and x.stage not in ('closed', 'cancelled') and a.status = 'open' and a.due_date < current_date) as overdue_actions
            from public.capas c
           where c.organisation_id = ${org}::uuid`),
      )
    ).rows[0];
    const stages = (
      await this.database.asUser(ctx, (db) =>
        db.execute<Row>(sql`select stage, count(*)::int as n from public.capas where organisation_id = ${org}::uuid and stage not in ('closed', 'cancelled') group by stage order by n desc`),
      )
    ).rows;
    const label: Record<string, string> = { open: 'Open', actions_in_progress: 'Actions in progress', awaiting_verification: 'Awaiting verification', verified_effective: 'Verified effective' };
    return {
      figures: [
        { label: '8Ds started', value: Number(k.started) },
        { label: '8Ds closed', value: Number(k.closed), note: `${k.on_time} by their due date` },
        { label: '8Ds running', value: Number(k.running) },
        { label: '8D actions overdue', value: Number(k.overdue_actions) },
      ] as Figure[],
      lists: [{ title: '8Ds running, by stage', items: stages.map((s) => ({ label: label[s.stage as string] ?? (s.stage as string), value: Number(s.n) })) }],
    };
  }
}
