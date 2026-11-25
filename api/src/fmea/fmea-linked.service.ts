import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Row } from '../calibration/calibration.service';
import type { RequestContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;

export type LinkedKind = 'part' | 'part_family' | 'machine' | 'control_plan';

export interface LinkedFmea {
  id: string;
  number: string;
  title: string;
  kind: 'design' | 'process';
  revisionId: string;
  letter: string | null;
  nextReviewOn: string | null;
  reviewOverdue: boolean;
  /** How it covers the thing asked about: the part itself, its family, the machine or the control plan. */
  via: ('part' | 'part_family' | 'machine' | 'control_plan')[];
}

/**
 * FMEA (FM5c, banners): the FMEAs in force that cover a part (itself or through its family), a part family, a machine or a control plan, for the banner and card on those pages
 * (plan FM16). Read as the caller, so an FMEA they may not read is not there; information only, nothing is blocked by an FMEA missing or out of date.
 */
@Injectable()
export class FmeaLinkedService {
  constructor(private readonly database: DatabaseService) {}

  linked(ctx: RequestContext, kind: LinkedKind, id: string) {
    const org = orgOf(ctx);
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.settle_fmeas(${org}::uuid)`);
      const match =
        kind === 'part'
          ? sql`((l.kind = 'part' and l.part_id = ${id}::uuid)
                 or (l.kind = 'part_family' and l.part_family_id = (select p.part_family_id from public.parts p where p.id = ${id}::uuid and p.organisation_id = ${org}::uuid)))`
          : kind === 'part_family'
            ? sql`(l.kind = 'part_family' and l.part_family_id = ${id}::uuid)`
            : kind === 'machine'
              ? sql`(l.kind = 'machine' and l.machine_id = ${id}::uuid)`
              : sql`(l.kind = 'control_plan' and l.control_plan_id = ${id}::uuid)`;
      const rows = await db.execute<Row>(sql`
        select f.id, f.number, f.title, f.kind, r.id as revision_id, r.letter, f.next_review_on::text as next_review_on,
               (f.next_review_on is not null and f.next_review_on < current_date) as overdue,
               array_agg(distinct l.kind order by l.kind) as via
          from public.fmeas f
          join public.fmea_revisions r on r.id = f.current_revision_id and r.status = 'effective'
          join public.fmea_links l on l.revision_id = r.id and l.organisation_id = f.organisation_id
         where f.organisation_id = ${org}::uuid and f.status = 'active' and ${match}
         group by f.id, f.number, f.title, f.kind, r.id, r.letter, f.next_review_on
         order by f.number`);
      const data: LinkedFmea[] = rows.rows.map((r) => ({
        id: r.id as string,
        number: r.number as string,
        title: r.title as string,
        kind: r.kind as 'design' | 'process',
        revisionId: r.revision_id as string,
        letter: (r.letter as string) ?? null,
        nextReviewOn: (r.next_review_on as string) ?? null,
        reviewOverdue: r.overdue === true,
        via: r.via as LinkedFmea['via'],
      }));
      const can = (await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'fmea.manage') as manage`)).rows[0];
      return { data, canRaise: can?.manage === true };
    });
  }
}
