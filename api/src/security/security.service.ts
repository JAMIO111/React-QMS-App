import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';

type Row = Record<string, unknown>;
const orgOf = (ctx: RequestContext) => {
  if (!ctx.organisationId) throw new Error('organisation-scoped route without an organisation');
  return ctx.organisationId;
};
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

/** How many addresses a range allows, in words a person can judge ("1 address", "16 addresses", "about 1.2 × 10^24 addresses"). */
export function addressCount(network: string): { count: string; single: boolean } {
  const [ip, maskText] = network.split('/');
  const bits = ip.includes(':') ? 128 : 32;
  const free = bits - Number(maskText ?? bits);
  if (free === 0) return { count: '1 address', single: true };
  if (free <= 40) return { count: `${(2 ** free).toLocaleString('en-GB')} addresses`, single: false };
  return { count: `2^${free} addresses`, single: false };
}

/**
 * Settings → Security → Access restrictions (docs/security-plan.md SE2): the organisation's network policy and approved networks, and the blocked
 * attempts. Every change goes through the database functions of SE1, which apply the rules (including lockout prevention, with the caller's own
 * address as the API sees it). Reads run as the person under RLS (security.read).
 */
@Injectable()
export class SecurityService {
  constructor(private readonly database: DatabaseService) {}

  policy(ctx: RequestContext) {
    return this.database.asUser(ctx, (db) => this.load(db, ctx));
  }

  setPolicy(ctx: RequestContext, mode: 'off' | 'monitor' | 'enforce', confirm: boolean) {
    if (mode === 'enforce' && !confirm) {
      throw ApiError.badRequest('confirmation_required', 'Confirm that people outside the approved networks will be blocked');
    }
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.set_network_policy(${orgOf(ctx)}::uuid, ${mode}, ${ctx.address ?? null}::inet)`);
      return this.load(db, ctx);
    });
  }

  saveNetwork(ctx: RequestContext, body: { name?: string; network?: string; active?: boolean }, id: string | null = null) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.save_organisation_network(${orgOf(ctx)}::uuid, ${JSON.stringify(body)}::jsonb, ${ctx.address ?? null}::inet, ${id}::uuid)`);
      return this.load(db, ctx);
    });
  }

  removeNetwork(ctx: RequestContext, id: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.ownNetwork(db, ctx, id);
      await db.execute(sql`select app.remove_organisation_network(${id}::uuid, ${reason}, ${ctx.address ?? null}::inet)`);
      return this.load(db, ctx);
    });
  }

  restoreNetwork(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.ownNetwork(db, ctx, id);
      await db.execute(sql`select app.restore_organisation_network(${id}::uuid)`);
      return this.load(db, ctx);
    });
  }

  denials(ctx: RequestContext, q: { from?: string; to?: string; userId?: string; mode?: 'monitor' | 'enforce'; limit?: number }) {
    return this.database.asUser(ctx, async (db) => {
      const rows = await db.execute<Row>(sql`
        select d.id, d.user_id, d.address, d.mode, d.attempts, d.last_path, d.first_at, d.last_at,
               nullif(btrim(concat_ws(' ', p.first_name, p.surname)), '') as person,
               exists (select 1 from public.organisation_networks n
                        where n.organisation_id = d.organisation_id and n.active and n.removed_at is null
                          and d.address <> 'unknown' and d.address::inet <<= n.network) as now_allowed
          from public.access_denials d
          left join public.profiles p on p.id = d.user_id
         where d.organisation_id = ${orgOf(ctx)}::uuid
           and (${q.from ?? null}::date is null or d.last_at >= ${q.from ?? null}::date)
           and (${q.to ?? null}::date is null or d.first_at < ${q.to ?? null}::date + 1)
           and (${q.userId ?? null}::uuid is null or d.user_id = ${q.userId ?? null}::uuid)
           and (${q.mode ?? null}::text is null or d.mode = ${q.mode ?? null})
         order by d.last_at desc
         limit ${q.limit ?? 200}`);
      return {
        data: rows.rows.map((r) => ({
          id: r.id as string,
          person: r.user_id ? { id: r.user_id as string, name: (r.person as string) ?? null } : null,
          address: r.address as string,
          mode: r.mode as 'monitor' | 'enforce',
          attempts: Number(r.attempts),
          lastPath: (r.last_path as string) ?? null,
          firstAt: iso(r.first_at)!,
          lastAt: iso(r.last_at)!,
          nowAllowed: Boolean(r.now_allowed),
        })),
      };
    });
  }

  private async ownNetwork(db: Db, ctx: RequestContext, id: string) {
    const r = await db.execute(sql`select 1 from public.organisation_networks where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (!r.rows[0]) throw ApiError.notFound('network_not_found', 'Network not found');
  }

  private async load(db: Db, ctx: RequestContext) {
    const org = orgOf(ctx);
    const address = ctx.address ?? null;
    const settings = await db.execute<Row>(sql`
      select s.network_policy, s.network_policy_changed_at,
             nullif(btrim(concat_ws(' ', p.first_name, p.surname)), '') as changed_by,
             app.has_permission(${org}::uuid, 'security.manage') as can_manage
        from public.organisation_settings s
        left join public.profiles p on p.id = s.network_policy_changed_by
       where s.organisation_id = ${org}::uuid`);
    const s = settings.rows[0] ?? {};
    const networks = await db.execute<Row>(sql`
      select n.id, n.name, n.network::text as network, n.active, n.removed_at, n.removed_reason, n.created_at, n.updated_at,
             nullif(btrim(concat_ws(' ', cp.first_name, cp.surname)), '') as created_by,
             nullif(btrim(concat_ws(' ', up.first_name, up.surname)), '') as updated_by,
             nullif(btrim(concat_ws(' ', rp.first_name, rp.surname)), '') as removed_by,
             (${address}::inet is not null and ${address}::inet <<= n.network) as includes_you
        from public.organisation_networks n
        left join public.profiles cp on cp.id = n.created_by
        left join public.profiles up on up.id = n.updated_by
        left join public.profiles rp on rp.id = n.removed_by
       where n.organisation_id = ${org}::uuid
       order by n.removed_at is not null, lower(n.name)`);
    const list = networks.rows.map((n) => ({
      id: n.id as string,
      name: n.name as string,
      network: n.network as string,
      ...addressCount(n.network as string),
      active: Boolean(n.active),
      removed: n.removed_at != null,
      removedAt: iso(n.removed_at),
      removedBy: (n.removed_by as string) ?? null,
      removedReason: (n.removed_reason as string) ?? null,
      includesYou: Boolean(n.includes_you),
      createdAt: iso(n.created_at)!,
      createdBy: (n.created_by as string) ?? null,
      updatedAt: iso(n.updated_at)!,
      updatedBy: (n.updated_by as string) ?? null,
    }));
    const live = list.filter((n) => !n.removed);
    return {
      mode: ((s.network_policy as string) ?? 'off') as 'off' | 'monitor' | 'enforce',
      changedAt: iso(s.network_policy_changed_at),
      changedBy: (s.changed_by as string) ?? null,
      canManage: Boolean(s.can_manage),
      address,
      /** Whether the caller's own address is inside an active network (enforcing needs it). */
      covered: live.some((n) => n.active && n.includesYou),
      activeCount: live.filter((n) => n.active).length,
      networks: list,
    };
  }
}
