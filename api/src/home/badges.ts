import { Controller, Get, Injectable } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { CapaService } from '../capa/capa.service';
import { ChangeService } from '../change/change.service';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { DocumentationService } from '../documentation/documentation.service';
import { DocumentsService } from '../documents/documents.service';
import { FmeaActionsService } from '../fmea/fmea-actions.service';
import { ManagementReviewsService } from '../management-review/management-reviews.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RiskDashboardService } from '../risk/risk-dashboard';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { WorkflowsService } from '../workflows/workflows.service';

const count = z.number().int();
export const Badges = z.object({
  /** Notices the caller has not read. */
  notifications: count,
  /** Open workflow tasks (any member). */
  tasks: count,
  /** Quality alerts still to acknowledge. `null` without `documentation.read`. */
  alerts: count.nullable(),
  /** Documents to read plus reviews waiting (any member). */
  documents: count,
  /** Open 8D actions. `null` without `capa.read`. */
  capaActions: count.nullable(),
  /** Overdue reviews, open actions and acceptances waiting on the caller. `null` without `risk.read`. */
  riskWork: count.nullable(),
  /** Sign-offs, tasks and overdue changes waiting on the caller. `null` without `change.read`. */
  changes: count.nullable(),
  /** Open FMEA actions. `null` without `fmea.read`. */
  fmeaActions: count.nullable(),
  /** Open management review actions (any member: RLS shows each person their own). */
  reviewActions: count,
});
export type Badges = z.infer<typeof Badges>;

/**
 * Every number the side menu and the bell show, in one request, so the browser polls once a minute instead of nine endpoints every few minutes.
 *
 * Each figure comes from the very service behind the page it leads to (so they cannot disagree; `badges.e2e-spec.ts` checks), and a figure the caller may
 * not read is `null`, never zero. They are worked out one after another on purpose: each service opens its own short transaction and a request must not
 * take several connections from a small pool at once. One failing never blanks the rest.
 */
@Injectable()
export class BadgesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly notifications: NotificationsService,
    private readonly workflows: WorkflowsService,
    private readonly alerts: DocumentationService,
    private readonly documents: DocumentsService,
    private readonly capa: CapaService,
    private readonly risk: RiskDashboardService,
    private readonly change: ChangeService,
    private readonly fmea: FmeaActionsService,
    private readonly reviews: ManagementReviewsService,
  ) {}

  async get(ctx: RequestContext): Promise<Badges> {
    const can = await this.database.asUser(ctx, async (db) => {
      const org = ctx.organisationId!;
      const r = (
        await db.execute<Record<string, boolean>>(sql`
          select app.has_permission(${org}::uuid, 'documentation.read') as documentation,
                 app.has_permission(${org}::uuid, 'capa.read') as capa,
                 app.has_permission(${org}::uuid, 'risk.read') as risk,
                 app.has_permission(${org}::uuid, 'change.read') as change,
                 app.has_permission(${org}::uuid, 'fmea.read') as fmea`)
      ).rows[0];
      return r;
    });

    const part = async <T>(wanted: boolean, work: () => Promise<T>): Promise<T | null> => {
      if (!wanted) return null;
      try {
        return await work();
      } catch {
        return null;
      }
    };
    const orZero = async (work: () => Promise<number>) => (await part(true, work)) ?? 0;

    return {
      notifications: await orZero(() => this.notifications.unreadCount(ctx)),
      tasks: await orZero(async () => (await this.workflows.myTasks(ctx, 'open')).openCount),
      alerts: await part(can.documentation, async () => (await this.alerts.mineCount(ctx)).unacknowledged),
      documents: await orZero(async () => (await this.documents.mineCount(ctx)).total),
      capaActions: await part(can.capa, async () => (await this.capa.myActions(ctx, { status: 'open' })).openCount),
      riskWork: await part(can.risk, async () => (await this.risk.count(ctx)).total),
      changes: await part(can.change, async () => (await this.change.mineCount(ctx)).total),
      fmeaActions: await part(can.fmea, async () => (await this.fmea.mine(ctx, { status: 'open' })).openCount),
      reviewActions: await orZero(async () => (await this.reviews.mine(ctx, 'open')).openCount),
    };
  }
}

@ApiTags('home')
@ApiBearerAuth()
@Controller('badges')
export class BadgesController {
  constructor(private readonly service: BadgesService) {}

  /** The numbers behind the menu badges and the bell (counts only). Any member may ask; a figure the caller may not read is `null`. */
  @Get()
  @OrganisationScoped()
  @ApiOkResponse({ schema: openApiSchema(Badges) })
  get(@Ctx() ctx: RequestContext) {
    return this.service.get(ctx);
  }
}
