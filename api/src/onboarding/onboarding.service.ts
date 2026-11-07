import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import type { GoLiveChecklist, OnboardingState, SetStepBody } from './onboarding.schemas';

/** The owner's set-up wizard: state is computed by the database (app.onboarding_state), progress is saved by functions. */
@Injectable()
export class OnboardingService {
  constructor(private readonly database: DatabaseService) {}

  state(ctx: RequestContext): Promise<OnboardingState> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx));
  }

  checklist(ctx: RequestContext): Promise<GoLiveChecklist> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ c: GoLiveChecklist }>(sql`select app.go_live_checklist(${ctx.organisationId!}::uuid) as c`);
      return res.rows[0].c;
    });
  }

  setStep(ctx: RequestContext, body: SetStepBody): Promise<OnboardingState> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.set_onboarding_step(${ctx.organisationId!}::uuid, ${body.step}, ${body.status})`);
      return this.load(db, ctx);
    });
  }

  complete(ctx: RequestContext): Promise<OnboardingState> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.complete_onboarding(${ctx.organisationId!}::uuid)`);
      return this.load(db, ctx);
    });
  }

  private async load(db: Db, ctx: RequestContext): Promise<OnboardingState> {
    const res = await db.execute<{ s: OnboardingState }>(sql`select app.onboarding_state(${ctx.organisationId!}::uuid) as s`);
    return res.rows[0].s;
  }
}
