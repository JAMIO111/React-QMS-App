import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { profiles } from '../database/schema';
import type { MeResponse, UpdateMeBody } from './me.schemas';

@Injectable()
export class MeService {
  constructor(private readonly database: DatabaseService) {}

  get(ctx: RequestContext): Promise<MeResponse> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx));
  }

  update(ctx: RequestContext, body: UpdateMeBody): Promise<MeResponse> {
    return this.database.asUser(ctx, async (db) => {
      await db
        .update(profiles)
        .set({
          ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
          ...(body.surname !== undefined ? { surname: body.surname } : {}),
          ...(body.jobTitle !== undefined ? { jobTitle: body.jobTitle || null } : {}),
        })
        .where(eq(profiles.id, ctx.user.id));
      return this.load(db, ctx);
    });
  }

  private async load(db: Db, ctx: RequestContext): Promise<MeResponse> {
    const [profile] = await db.select().from(profiles).where(eq(profiles.id, ctx.user.id));
    const memberships = await db.execute<{
      membership_id: string;
      organisation_id: string;
      name: string;
      slug: string;
      permissions: string[] | null;
    }>(sql`
      select m.id as membership_id, o.id as organisation_id, o.name, o.slug,
             array(select p from app.my_permissions(o.id) p order by p) as permissions
      from public.organisation_users m
      join public.organisations o on o.id = m.organisation_id and o.status = 'active'
      where m.user_id = auth.uid() and m.status = 'active'
      order by o.name`);
    // Organisations requiring MFA are left out of `memberships` (RLS hides them from an aal1
    // session); list them so the app can ask the user to set up or confirm two-factor.
    const blocked = await db.execute<{ organisation_id: string; name: string }>(
      sql`select organisation_id, name from app.mfa_blocked_organisations()`,
    );
    const blockedIds = new Set(blocked.rows.map((b) => b.organisation_id));

    return {
      profile: {
        id: ctx.user.id,
        email: ctx.user.email ?? null,
        firstName: profile?.firstName ?? null,
        surname: profile?.surname ?? null,
        jobTitle: profile?.jobTitle ?? null,
        avatarPath: profile?.avatarPath ?? null,
      },
      mfa: {
        level: ctx.user.claims.aal === 'aal2' ? 'aal2' : 'aal1',
        requiredBy: blocked.rows.map((b) => ({ id: b.organisation_id, name: b.name })),
      },
      memberships: memberships.rows.filter((m) => !blockedIds.has(m.organisation_id)).map((m) => ({
        membershipId: m.membership_id,
        organisation: { id: m.organisation_id, name: m.name, slug: m.slug },
        permissions: m.permissions ?? [],
      })),
    };
  }
}
