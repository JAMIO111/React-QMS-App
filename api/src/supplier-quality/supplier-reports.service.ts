import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { todayUtc } from './expiry';
import { Report, ReportQuery } from './supplier-reports.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const pct = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 1000) / 10);
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const PERFORMANCE_COLUMNS = [
  ['code', 'Supplier'], ['name', 'Name'], ['approvalStatus', 'Approval status'], ['riskRating', 'Risk rating'], ['band', 'Band'], ['score', 'Score'],
  ['otdPercent', 'On-time delivery %'], ['onTime', 'Lines on time'], ['matchedLines', 'Lines against an order'], ['ppm', 'PPM (rejected)'], ['rejectedUnits', 'Units rejected'], ['ppmNc', 'PPM (non-conformances)'], ['ncUnits', 'Units on non-conformances'], ['ncUnitsUnlinked', 'Of which not linked to a receipt'], ['receivedUnits', 'Units received'],
  ['inFullPercent', 'In full %'], ['otifPercent', 'OTIF %'],
  ['lotRejectionPercent', 'Lot rejection %'], ['ncTotal', 'Non-conformances'], ['ncCritical', 'Critical'], ['ncMajor', 'Major'], ['ncMinor', 'Minor'], ['ncRepeat', 'Repeat'],
  ['scarIssued', 'Corrective action requests issued'], ['scarOnTime', 'Answered on time'], ['scarLate', 'Answered late'], ['scarOverdue', 'Overdue now'],
  ['certsCurrent', 'Current certifications'], ['certsExpired', 'Expired certifications'], ['warnings', 'Warnings'],
].map(([key, label]) => ({ key, label }));

const PERFORMANCE_DEFINITIONS = [
  'PPM (rejected) = units rejected at receiving ÷ units received × 1,000,000. A rejection counts the quantity entered on it, or the whole line when none was.',
  'PPM (non-conformances) = units on live non-conformances linked to a received line (counted once per line, at most what was received) ÷ units received × 1,000,000; when the model says so, pieces on supplier NCs with no receipt linked are added. Which of the two scores is a model setting.',
  'In full % = order lines due in the period that had received, by the due date plus the days late allowed, the ordered quantity within the in-full tolerances. OTIF % = those that were also not delivered earlier than the days-early allowance.',
  'Lot rejection % = rejected delivered lines ÷ delivered lines. It is not PPM.',
  'On-time delivery % = delivered lines against an order line received within the grace days of the due date (days early allowed, if limited, and days late allowed). Lines with no order line are left out.',
  'Non-conformances are live non-conformances naming the supplier, detected in the period; repeat = on a part with two or more in the period.',
  'Corrective action requests are those issued in the period; "answered on time" means the first response came by the original due date.',
  'Certifications are the current ones, as at the date the report was generated.',
  'Score is the weighted average of the metrics that have enough data (0 to 100); with under half the weight covered there is no score and the band is "insufficient".',
  'Cancelled receipts are never counted. Nothing in this report changes a supplier\'s approval status.',
];

const AUDIT_COLUMNS = [
  ['supplier', 'Supplier'], ['supplierName', 'Name'], ['record', 'Audit record'], ['audit', 'Audit'], ['auditTitle', 'Title'], ['version', 'Audit version'], ['performedOn', 'Performed on'], ['status', 'Status'],
  ['result', 'Result'], ['score', 'Score %'], ['passMark', 'Pass mark %'], ['auditor', 'Auditor'], ['findings', 'Findings'], ['nonConformances', 'Non-conformances raised'],
].map(([key, label]) => ({ key, label }));

const AUDIT_DEFINITIONS = [
  'One row per audit record and supplier it was carried out on (a record carried out on several suppliers appears once for each).',
  'Records are included by the date they were performed; abandoned records are left out.',
  'Result is pass or fail as worked out when the audit was completed; score is passes ÷ (passes + fails), with "not applicable" answers left out.',
  'Findings are those raised on the record that are not withdrawn; non-conformances are the live ones linked to the record.',
];

/** Supplier reports for export: the figures with the period, the rules used and when they were worked out. The screen turns a report into a CSV file. */
@Injectable()
export class SupplierReportsService {
  constructor(private readonly database: DatabaseService) {}

  private period(q: ReportQuery) {
    const to = q.to ?? todayUtc();
    const from = q.from ?? addDays(to, -89);
    if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw ApiError.badRequest('report_period', 'A report covers at most a year');
    return { from, to };
  }

  /** Every active supplier scored over the period under the organisation's current model, in code order. */
  performance(ctx: RequestContext, q: ReportQuery): Promise<Report> {
    const { from, to } = this.period(q);
    return this.database.asUser(ctx, async (db) => {
      const suppliers = await db.execute<Row>(sql`
        select id, code, name, approval_status, risk_rating from public.suppliers
        where organisation_id = ${orgOf(ctx)}::uuid and active order by code limit 500`);
      const rows: Report['rows'] = [];
      let model: { version: number; config: Record<string, unknown> } | null = null;
      for (const s of suppliers.rows) {
        const res = await db.execute<{ r: Record<string, unknown> }>(sql`select app.supplier_performance(${s.id as string}::uuid, ${from}::date, ${to}::date) as r`);
        const r = res.rows[0].r as { model: { version: number; config: Record<string, unknown> }; metrics: Record<string, Record<string, unknown>>; score: unknown; band: string; warnings: Array<{ level: string; message: string }> };
        model = r.model;
        const m = r.metrics;
        const warn = r.warnings.filter((w) => w.level !== 'info');
        rows.push({
          code: s.code as string, name: s.name as string, approvalStatus: s.approval_status as string, riskRating: (s.risk_rating as string) ?? null, band: r.band, score: n(r.score),
          otdPercent: pct(m.otd.value), onTime: n(m.otd.onTime), matchedLines: n(m.otd.matchedLines), ppm: n(m.ppm.value), rejectedUnits: n(m.ppm.rejectedUnits), ppmNc: n(m.ppmNc?.value), ncUnits: n(m.ppmNc?.affectedUnits), ncUnitsUnlinked: m.ppmNc?.includeUnlinked ? n(m.ppmNc?.unlinkedUnits) : null, receivedUnits: n(m.ppm.receivedUnits),
          inFullPercent: pct(m.inFull?.value), otifPercent: pct(m.otif?.value),
          lotRejectionPercent: pct(m.lotRejection.rate), ncTotal: n(m.ncs.total), ncCritical: n(m.ncs.critical), ncMajor: n(m.ncs.major), ncMinor: n(m.ncs.minor), ncRepeat: n(m.ncs.repeat),
          scarIssued: n(m.scars.issued), scarOnTime: n(m.scars.answered_on_time), scarLate: n(m.scars.answered_late), scarOverdue: n(m.scars.overdue_now),
          certsCurrent: n(m.certs.current), certsExpired: n(m.certs.expired), warnings: warn.map((w) => w.message).join('; ') || null,
        });
      }
      const c = (model?.config ?? {}) as { otd_policy?: string; ppm_basis?: string; ppm_nc_include_unlinked?: boolean; grace_days_before?: number | null; grace_days_after?: number; in_full_under_pct?: number; in_full_over_pct?: number; weights?: Record<string, number>; good_from?: number; watch_from?: number; min_lines?: number; ppm_good?: number; ppm_zero?: number };
      return {
        meta: {
          title: 'Supplier performance',
          from, to, generatedAt: new Date().toISOString(),
          definitions: PERFORMANCE_DEFINITIONS,
          basis: model ? [
            { label: 'Scoring model version', value: String(model.version) },
            { label: 'On-time delivery judged against', value: c.otd_policy === 'original' ? 'the original requested date' : 'the latest agreed date' },
            { label: 'Days early / late that still count as on time', value: `${c.grace_days_before ?? 'no limit'} / ${c.grace_days_after ?? 0} (a supplier may override this)` },
            { label: 'In full: below / above the ordered quantity', value: `${c.in_full_under_pct ?? 0}% / ${c.in_full_over_pct ?? 10}%` },
            { label: 'NC-based PPM counts non-conformances with no receipt', value: c.ppm_nc_include_unlinked ? 'yes' : 'no (only those linked to a received line)' },
            { label: 'PPM that scores', value: c.ppm_basis === 'ncs' ? 'units on non-conformances' : 'units rejected at receiving' },
            { label: 'Weights (on-time / in full / PPM / non-conformances / corrective actions / certifications)', value: ['otd', 'in_full', 'ppm', 'ncs', 'scar', 'certs'].map((k) => c.weights?.[k] ?? 0).join(' / ') },
            { label: 'PPM scoring 100 / scoring 0', value: `${c.ppm_good} / ${c.ppm_zero}` },
            { label: 'Bands', value: `good from ${c.good_from}, watch from ${c.watch_from}, poor below` },
            { label: 'Delivered lines needed to score on-time delivery and PPM', value: String(c.min_lines) },
          ] : [],
          rowCount: rows.length,
        },
        columns: PERFORMANCE_COLUMNS,
        rows,
      };
    });
  }

  /** Audit records carried out on suppliers during the period, one row per record and supplier. */
  audits(ctx: RequestContext, q: ReportQuery): Promise<Report> {
    const { from, to } = this.period(q);
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`
        select s.code as supplier, s.name as supplier_name, r.reference as record, r.audit_reference as audit, r.audit_title, r.audit_version, to_char(r.performed_on, 'YYYY-MM-DD') as performed_on,
               r.status, r.result, r.score, r.pass_mark,
               nullif(trim(concat_ws(' ', p.first_name, p.surname)), '') as auditor,
               (select count(*) from public.audit_findings f where f.audit_record_id = r.id and f.status <> 'withdrawn') as findings,
               (select count(distinct l.nonconformance_id) from public.audit_ncr_links l join public.nonconformances nc on nc.id = l.nonconformance_id and nc.deleted_at is null and nc.stage <> 'cancelled' where l.audit_record_id = r.id) as ncs
          from public.audit_record_targets t
          join public.audit_records r on r.id = t.audit_record_id and r.status <> 'abandoned' and r.performed_on between ${from}::date and ${to}::date
          join public.suppliers s on s.id = t.supplier_id
          left join public.profiles p on p.id = coalesce(r.completed_by, r.started_by)
         where t.organisation_id = ${orgOf(ctx)}::uuid and t.kind = 'supplier'
         order by s.code, r.performed_on, r.reference`);
      const rows: Report['rows'] = res.rows.map((r) => ({
        supplier: r.supplier as string, supplierName: r.supplier_name as string, record: r.record as string, audit: r.audit as string, auditTitle: r.audit_title as string, version: n(r.audit_version),
        performedOn: r.performed_on as string, status: r.status as string, result: (r.result as string) ?? null, score: n(r.score), passMark: n(r.pass_mark), auditor: (r.auditor as string) ?? null,
        findings: n(r.findings), nonConformances: n(r.ncs),
      }));
      return { meta: { title: 'Supplier audits', from, to, generatedAt: new Date().toISOString(), definitions: AUDIT_DEFINITIONS, basis: [], rowCount: rows.length }, columns: AUDIT_COLUMNS, rows };
    });
  }
}
