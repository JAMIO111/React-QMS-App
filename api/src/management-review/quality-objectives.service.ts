import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { CreateObjectiveBody, Measure, RecordValueBody, UpdateObjectiveBody } from './quality-objectives.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const STEP: Record<string, string> = { monthly: '1 month', quarterly: '3 months', yearly: '1 year' };
const TRUNC: Record<string, string> = { monthly: 'month', quarterly: 'quarter', yearly: 'year' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The fixed measures: what each counts, in words, and the permission needed to read what it counts. */
export const MEASURE_INFO: Record<Measure, { label: string; unit: string | null; direction: 'at_least' | 'at_most' | null; description: string; permission: string | null }> = {
  manual: { label: 'Entered by hand', unit: null, direction: null, description: 'A value typed in for each period by the objective\'s owner or a manager', permission: null },
  ncr_count: { label: 'Non-conformances raised', unit: 'NCs', direction: 'at_most', description: 'Non-conformances raised in the period (cancelled and deleted ones left out)', permission: 'ncr.read' },
  supplier_ppm: {
    label: 'Supplier PPM at goods receipt',
    unit: 'PPM',
    direction: 'at_most',
    description: 'Units rejected at goods receipt per million received in the period, across every supplier (a line counts its rejected quantity, else the whole line)',
    permission: 'receiving.read',
  },
  capa_on_time: { label: '8Ds closed on time', unit: '%', direction: 'at_least', description: '8Ds closed in the period by their due date (one with no due date counts as on time), as a percentage of those closed', permission: 'capa.read' },
  audit_pass_rate: { label: 'Audit pass rate', unit: '%', direction: 'at_least', description: 'Audits completed in the period that passed, as a percentage of those completed', permission: 'audits.read' },
};

export const periodLabel = (frequency: string, start: string) => {
  const [y, m] = start.split('-').map(Number);
  if (frequency === 'yearly') return String(y);
  if (frequency === 'quarterly') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  return `${MONTHS[m - 1]} ${y}`;
};

export const standing = (direction: string, target: number, value: number | null) =>
  value == null ? 'no_value' : (direction === 'at_least' ? value >= target : value <= target) ? 'on_target' : 'off_target';

type Measured = { value: number | null; numerator: number | null; denominator: number | null };

/**
 * A system measure for each period from `from` to `to` (period starts), read as the caller (RLS). Values for the period in progress are "so far".
 * A percentage or PPM with nothing to divide by is null (no value), never zero.
 */
async function systemValues(db: Db, org: string, measure: Measure, frequency: string, from: string, to: string): Promise<Map<string, Measured>> {
  const step = sql.raw(`interval '${STEP[frequency]}'`);
  const periods = sql`select p::date as p, (p + ${step})::date as e from generate_series(${from}::date, ${to}::date, ${step}) p`;
  let rows: Row[] = [];
  if (measure === 'ncr_count') {
    rows = (
      await db.execute<Row>(sql`
        select s.p::text as p, (select count(*)::int from public.nonconformances n
                                 where n.organisation_id = ${org}::uuid and n.deleted_at is null and n.stage <> 'cancelled'
                                   and n.created_at::date >= s.p and n.created_at::date < s.e) as num, null::numeric as den
          from (${periods}) s`)
    ).rows;
  } else if (measure === 'supplier_ppm') {
    rows = (
      await db.execute<Row>(sql`
        select s.p::text as p,
               (select coalesce(sum(case when d.decision = 'rejected' then coalesce(d.quantity_rejected, x.quantity_received) end), 0)
                  from public.goods_receipt_lines x join public.goods_receipts g on g.id = x.goods_receipt_id
                  left join lateral (select r.decision, r.quantity_rejected from public.receipt_line_dispositions r where r.receipt_line_id = x.id order by r.decided_at desc, r.id desc limit 1) d on true
                 where g.organisation_id = ${org}::uuid and g.status = 'received' and g.received_on >= s.p and g.received_on < s.e) as num,
               (select coalesce(sum(x.quantity_received), 0)
                  from public.goods_receipt_lines x join public.goods_receipts g on g.id = x.goods_receipt_id
                 where g.organisation_id = ${org}::uuid and g.status = 'received' and g.received_on >= s.p and g.received_on < s.e) as den
          from (${periods}) s`)
    ).rows;
  } else if (measure === 'capa_on_time') {
    rows = (
      await db.execute<Row>(sql`
        select s.p::text as p, count(c.id) filter (where c.closed_at::date <= coalesce(c.due_date, c.closed_at::date))::int as num, count(c.id)::int as den
          from (${periods}) s
          left join public.capas c on c.organisation_id = ${org}::uuid and c.stage = 'closed' and c.closed_at::date >= s.p and c.closed_at::date < s.e
         group by s.p`)
    ).rows;
  } else if (measure === 'audit_pass_rate') {
    rows = (
      await db.execute<Row>(sql`
        select s.p::text as p, count(r.id) filter (where r.result = 'pass')::int as num, count(r.id)::int as den
          from (${periods}) s
          left join public.audit_records r on r.organisation_id = ${org}::uuid and r.status = 'completed' and r.completed_at::date >= s.p and r.completed_at::date < s.e
         group by s.p`)
    ).rows;
  }
  const out = new Map<string, Measured>();
  for (const r of rows) {
    const num = Number(r.num ?? 0);
    const den = r.den == null ? null : Number(r.den);
    let value: number | null = num;
    if (measure === 'supplier_ppm') value = den ? Math.round((num / den) * 1_000_000) : null;
    if (measure === 'capa_on_time' || measure === 'audit_pass_rate') value = den ? Math.round((num / den) * 1000) / 10 : null;
    out.set(String(r.p).slice(0, 10), { value, numerator: num, denominator: den });
  }
  return out;
}

const OBJECTIVE_SELECT = sql`
  select o.*, o.starts_on::text as starts, ${sql.raw(personName('po'))} as owner_name, ${sql.raw(personName('pr'))} as retired_by_name
    from public.quality_objectives o
    left join public.profiles po on po.id = o.owner_user_id
    left join public.profiles pr on pr.id = o.retired_by`;

/** Quality objectives (MR1): the objectives, their measured values per period and how each stands against its target. Writes are database functions; reading is by RLS. */
@Injectable()
export class QualityObjectivesService {
  constructor(private readonly database: DatabaseService) {}

  measures(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const held = (await db.execute<Row>(sql`select coalesce(array_agg(p), '{}') as held from unnest(${'{ncr.read,receiving.read,capa.read,audits.read}'}::text[]) p where app.has_permission(${orgOf(ctx)}::uuid, p)`))
        .rows[0].held as string[];
      return {
        data: (Object.keys(MEASURE_INFO) as Measure[]).map((key) => {
          const m = MEASURE_INFO[key];
          return { key, label: m.label, unit: m.unit, direction: m.direction, description: m.description, available: m.permission == null || held.includes(m.permission) };
        }),
      };
    });
  }

  /** The periods from the objective's first (or `count` back) to the current one, oldest first, each with its value and standing. */
  private async periodsOf(db: Db, ctx: RequestContext, o: Row, count: number, withHistory: boolean) {
    const org = orgOf(ctx);
    const freq = o.frequency as string;
    const measure = o.measure as Measure;
    const bounds = (
      await db.execute<Row>(sql`
        select greatest(${o.starts}::date, (date_trunc(${TRUNC[freq]}, current_date) - ${sql.raw(`interval '${STEP[freq]}'`)} * ${count - 1})::date)::text as f,
               date_trunc(${TRUNC[freq]}, current_date)::date::text as t`)
    ).rows[0];
    const from = bounds.f as string;
    const to = bounds.t as string;
    const info = MEASURE_INFO[measure];
    const available = info.permission == null || Boolean((await db.execute<Row>(sql`select app.has_permission(${org}::uuid, ${info.permission}) as ok`)).rows[0].ok);
    const starts: string[] = (
      await db.execute<Row>(sql`select p::date::text as p from generate_series(${from}::date, ${to}::date, ${sql.raw(`interval '${STEP[freq]}'`)}) p`)
    ).rows.map((r) => r.p as string);
    const ends = new Map(
      (await db.execute<Row>(sql`select p::date::text as p, ((p + ${sql.raw(`interval '${STEP[freq]}'`)})::date - 1)::text as e from generate_series(${from}::date, ${to}::date, ${sql.raw(`interval '${STEP[freq]}'`)}) p`)).rows.map(
        (r) => [r.p as string, r.e as string],
      ),
    );
    let measured = new Map<string, Measured & { note?: string | null; by?: string | null; at?: string | null; corrections?: unknown[] }>();
    if (measure === 'manual') {
      const values = (
        await db.execute<Row>(sql`
          select v.period_start::text as p, v.value, v.note, v.status, v.created_at, ${sql.raw(personName('pv'))} as by_name
            from public.quality_objective_values v left join public.profiles pv on pv.id = v.created_by
           where v.objective_id = ${o.id}::uuid and v.period_start between ${from}::date and ${to}::date
           order by v.created_at desc, v.id`)
      ).rows;
      for (const v of values.filter((x) => x.status === 'current')) {
        measured.set(v.p as string, {
          value: Number(v.value), numerator: null, denominator: null, note: (v.note as string) ?? null, by: (v.by_name as string) ?? null, at: iso(v.created_at) as string,
          corrections: withHistory
            ? values.filter((x) => x.status === 'superseded' && x.p === v.p).map((x) => ({ value: Number(x.value), note: (x.note as string) ?? null, by: (x.by_name as string) ?? null, at: iso(x.created_at) as string }))
            : [],
        });
      }
    } else if (available) {
      measured = await systemValues(db, org, measure, freq, from, to);
    }
    const target = Number(o.target);
    return {
      available,
      periods: starts.map((p) => {
        const m = measured.get(p);
        const value = m?.value ?? null;
        return {
          periodStart: p,
          periodEnd: ends.get(p) as string,
          label: periodLabel(freq, p),
          /** The period in progress: a system value is "so far". */
          current: p === to,
          value,
          numerator: m?.numerator ?? null,
          denominator: m?.denominator ?? null,
          note: m?.note ?? null,
          recordedBy: m?.by ?? null,
          recordedAt: m?.at ?? null,
          corrections: withHistory ? (m?.corrections ?? []) : undefined,
          standing: available ? standing(o.direction as string, target, value) : 'unavailable',
        };
      }),
    };
  }

  /** The latest period worth judging: the last finished one with a value, else the one in progress. */
  private latest<T extends { current: boolean; value: number | null }>(periods: T[]) {
    const done = [...periods].reverse().find((p) => !p.current && p.value != null);
    return done ?? periods.find((p) => p.current && p.value != null) ?? null;
  }

  private async can(db: Db, org: string) {
    return Boolean((await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'management_review.manage') as ok`)).rows[0].ok);
  }

  private toObjective(o: Row, manage: boolean, me: string) {
    const measure = o.measure as Measure;
    return {
      id: o.id as string,
      reference: o.reference as string,
      title: o.title as string,
      description: (o.description as string) ?? null,
      owner: { id: o.owner_user_id as string, name: (o.owner_name as string) ?? 'Unknown' },
      measure,
      measureLabel: MEASURE_INFO[measure].label,
      measureDescription: MEASURE_INFO[measure].description,
      unit: (o.unit as string) ?? null,
      direction: o.direction as 'at_least' | 'at_most',
      target: Number(o.target),
      frequency: o.frequency as 'monthly' | 'quarterly' | 'yearly',
      startsOn: o.starts as string,
      active: Boolean(o.active),
      retiredReason: (o.retired_reason as string) ?? null,
      retiredAt: o.retired_at ? (iso(o.retired_at) as string) : null,
      retiredBy: (o.retired_by_name as string) ?? null,
      canManage: manage,
      /** Values are typed in for a manual objective that is in use, by a manager or its owner. */
      canRecord: measure === 'manual' && Boolean(o.active) && (manage || o.owner_user_id === me),
      createdAt: iso(o.created_at) as string,
      updatedAt: iso(o.updated_at) as string,
    };
  }

  list(ctx: RequestContext, all: boolean) {
    return this.database.asUser(ctx, async (db) => {
      const manage = await this.can(db, orgOf(ctx));
      const rows = (await db.execute<Row>(sql`select * from (${OBJECTIVE_SELECT}) o where o.organisation_id = ${orgOf(ctx)}::uuid ${all ? sql`` : sql`and o.active`} order by o.active desc, o.reference`)).rows;
      const data = [];
      for (const o of rows) {
        const { available, periods } = await this.periodsOf(db, ctx, o, 6, false);
        const latest = this.latest(periods);
        data.push({ ...this.toObjective(o, manage, ctx.user.id), available, latest, standing: available ? (latest?.standing ?? 'no_value') : 'unavailable', trend: periods });
      }
      return { data, canManage: manage };
    });
  }

  private async detailIn(db: Db, ctx: RequestContext, id: string, count = 12) {
    const rows = (await db.execute<Row>(sql`select * from (${OBJECTIVE_SELECT}) o where o.id = ${id}::uuid and o.organisation_id = ${orgOf(ctx)}::uuid`)).rows;
    if (rows.length === 0) throw ApiError.notFound('objective_not_found', 'Quality objective not found');
    const manage = await this.can(db, orgOf(ctx));
    const { available, periods } = await this.periodsOf(db, ctx, rows[0], count, true);
    const latest = this.latest(periods);
    const judged = periods.filter((p) => !p.current && p.value != null);
    return {
      ...this.toObjective(rows[0], manage, ctx.user.id),
      available,
      latest,
      standing: available ? (latest?.standing ?? 'no_value') : 'unavailable',
      /** Finished periods with a value, and how many met the target. */
      summary: { periods: judged.length, onTarget: judged.filter((p) => p.standing === 'on_target').length },
      periods,
    };
  }

  get(ctx: RequestContext, id: string, count: number) {
    return this.database.asUser(ctx, (db) => this.detailIn(db, ctx, id, count));
  }

  create(ctx: RequestContext, body: CreateObjectiveBody) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`select app.save_quality_objective(${orgOf(ctx)}::uuid, ${JSON.stringify(body)}::jsonb) as id`);
      return this.detailIn(db, ctx, res.rows[0].id);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateObjectiveBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.mustExist(db, ctx, id);
      await db.execute(sql`select app.save_quality_objective(${orgOf(ctx)}::uuid, ${JSON.stringify(body)}::jsonb, ${id}::uuid)`);
      return this.detailIn(db, ctx, id);
    });
  }

  retire(ctx: RequestContext, id: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.mustExist(db, ctx, id);
      await db.execute(sql`select app.retire_quality_objective(${id}::uuid, ${reason})`);
      return this.detailIn(db, ctx, id);
    });
  }

  reactivate(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.mustExist(db, ctx, id);
      await db.execute(sql`select app.reactivate_quality_objective(${id}::uuid)`);
      return this.detailIn(db, ctx, id);
    });
  }

  recordValue(ctx: RequestContext, id: string, body: RecordValueBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.mustExist(db, ctx, id);
      await db.execute(sql`select app.record_quality_objective_value(${id}::uuid, ${body.periodStart}::date, ${body.value}::numeric, ${body.note ?? null})`);
      return this.detailIn(db, ctx, id);
    });
  }

  /** An id of another organisation, or one the caller may not read, is 404 before any function runs. */
  private async mustExist(db: Db, ctx: RequestContext, id: string) {
    const found = await db.execute(sql`select 1 from public.quality_objectives where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (found.rows.length === 0) throw ApiError.notFound('objective_not_found', 'Quality objective not found');
  }
}
