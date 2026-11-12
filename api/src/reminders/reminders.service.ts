import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Row } from '../calibration/calibration.service';
import type { RequestContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { reminderPath } from './reminder-paths';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;

/**
 * Reminders (docs/workflow-engine-plan.md, WK2). The database decides who is told what (`app.reminder_candidates`, checked as each person); this reads a
 * person's own items and areas, and runs the daily step for the worker.
 */
@Injectable()
export class RemindersService {
  constructor(private readonly database: DatabaseService) {}

  /** The caller's own items now (overdue first, then by due date), with each area's label and whether it is switched on. */
  mine(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const org = orgOf(ctx);
      const areas = (await db.execute<Row>(sql`select key, label, description, soon_days, enabled from app.my_reminder_areas(${org}::uuid)`)).rows;
      const label = new Map(areas.map((a) => [a.key as string, a.label as string]));
      const rows = (
        await db.execute<Row>(sql`
          select area, record_id, target_id, label, due_on::text as due_on, overdue, area_enabled, today::text as today from app.my_reminders(${org}::uuid)`)
      ).rows;
      const items = rows.map((r) => ({
        area: r.area as string,
        areaLabel: label.get(r.area as string) ?? (r.area as string),
        recordId: r.record_id as string,
        targetId: r.target_id as string,
        label: r.label as string,
        dueOn: r.due_on as string,
        overdue: Boolean(r.overdue),
        areaEnabled: Boolean(r.area_enabled),
        path: reminderPath(r.area, r.target_id),
      }));
      items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.dueOn.localeCompare(b.dueOn) || a.label.localeCompare(b.label));
      return {
        today: (rows[0]?.today as string) ?? (await db.execute<Row>(sql`select (now() at time zone app.organisation_time_zone(${org}::uuid))::date::text as d`)).rows[0].d,
        counts: { overdue: items.filter((i) => i.overdue).length, dueSoon: items.filter((i) => !i.overdue).length },
        data: items,
      };
    });
  }

  areas(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const org = orgOf(ctx);
      const rows = (await db.execute<Row>(sql`select key, label, description, soon_days, enabled from app.my_reminder_areas(${org}::uuid)`)).rows;
      const settings = (
        await db.execute<Row>(sql`
          select to_char(coalesce(s.reminder_time, '07:00'::time), 'HH24:MI') as reminder_time, app.organisation_time_zone(${org}::uuid) as time_zone
            from public.organisations o left join public.organisation_settings s on s.organisation_id = o.id where o.id = ${org}::uuid`)
      ).rows[0];
      return {
        reminderTime: (settings?.reminder_time as string) ?? '07:00',
        timeZone: (settings?.time_zone as string) ?? 'Europe/London',
        data: rows.map((r) => ({
          area: r.key as string,
          label: r.label as string,
          description: r.description as string,
          soonDays: Number(r.soon_days),
          enabled: Boolean(r.enabled),
        })),
      };
    });
  }

  async setArea(ctx: RequestContext, area: string, enabled: boolean) {
    await this.database.asUser(ctx, (db) => db.execute(sql`select app.set_reminder_area(${orgOf(ctx)}::uuid, ${area}, ${enabled})`));
    return this.areas(ctx);
  }

  /** The worker's daily step: every organisation whose reminder time has come and has not run today. */
  runDaily(correlationId: string): Promise<{ organisations: number; digests: number; overdueNotices: number }> {
    return this.database.asApi(
      async (c) => (await c.query(`select app.system_run_reminders(200) as r`)).rows[0].r as { organisations: number; digests: number; overdueNotices: number },
      correlationId,
      'worker',
    );
  }
}
