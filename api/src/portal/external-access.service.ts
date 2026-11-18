import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { InvitationMailer } from '../members/invitation-mailer.service';

type Row = Record<string, unknown>;
const orgOf = (ctx: RequestContext) => {
  if (!ctx.organisationId) throw new Error('organisation-scoped route without an organisation');
  return ctx.organisationId;
};
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export function personRow(r: Row) {
  return {
    id: r.access_id as string,
    partyId: r.party_id as string,
    partyKind: r.party_kind as 'supplier' | 'customer',
    partyName: r.party_name as string,
    email: r.email as string,
    name: [r.first_name, r.surname].filter(Boolean).join(' ') || null,
    role: r.role as 'admin' | 'member',
    status: r.status as 'invited' | 'active' | 'suspended' | 'removed',
    invitedAt: iso(r.invited_at),
    inviteExpiresAt: iso(r.invite_expires_at),
    sendCount: Number(r.send_count ?? 0),
    acceptedAt: iso(r.accepted_at),
    lastSignInAt: iso(r.last_sign_in_at),
    suspendedReason: (r.suspended_reason as string | null) ?? null,
    removedAt: iso(r.removed_at),
    removedReason: (r.removed_reason as string | null) ?? null,
  };
}

/**
 * Settings → External access (docs/external-portal-plan.md PT1): the portal switch, which suppliers and customers may use it, and their people.
 * Everything is a database function (the database checks external_access.manage again); reads run as the person under RLS.
 */
@Injectable()
export class ExternalAccessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly mailer: InvitationMailer,
  ) {}

  overview(ctx: RequestContext) {
    return this.database.asUser(ctx, (db) => this.load(db, ctx));
  }

  private async load(db: Db, ctx: RequestContext) {
    const org = orgOf(ctx);
    const settings = await db.execute<{ portal_enabled: boolean; portal_ranking_enabled: boolean; portal_require_mfa: boolean; can_manage: boolean }>(
      sql`select portal_enabled, portal_ranking_enabled, portal_require_mfa, app.has_permission(organisation_id, 'external_access.manage') as can_manage
            from public.organisation_settings where organisation_id = ${org}::uuid`,
    );
    const parties = await db.execute<Row>(
      sql`select * from (
            select 'supplier' as kind, s.id as record_id, s.code, s.name, s.active, p.id as party_id, coalesce(p.enabled, false) as enabled,
                   p.contact_name, coalesce(p.tiles, '{}'::jsonb) as tiles,
                   (select count(*) from public.external_access a where a.party_id = p.id and a.status = 'active') as active_people,
                   (select count(*) from public.external_access a where a.party_id = p.id and a.status = 'invited') as invited_people
              from public.suppliers s left join public.portal_parties p on p.supplier_id = s.id and p.organisation_id = s.organisation_id
             where s.organisation_id = ${org}::uuid
            union all
            select 'customer', c.id, c.code, c.name, c.active, p.id, coalesce(p.enabled, false), p.contact_name, coalesce(p.tiles, '{}'::jsonb),
                   (select count(*) from public.external_access a where a.party_id = p.id and a.status = 'active'),
                   (select count(*) from public.external_access a where a.party_id = p.id and a.status = 'invited')
              from public.customers c left join public.portal_parties p on p.customer_id = c.id and p.organisation_id = c.organisation_id
             where c.organisation_id = ${org}::uuid
          ) x order by x.enabled desc, x.name`,
    );
    const s = settings.rows[0];
    return {
      settings: { enabled: Boolean(s?.portal_enabled), rankingEnabled: Boolean(s?.portal_ranking_enabled), requireMfa: s?.portal_require_mfa !== false },
      canManage: Boolean(s?.can_manage),
      parties: parties.rows.map((r) => ({
        kind: r.kind as 'supplier' | 'customer',
        recordId: r.record_id as string,
        partyId: (r.party_id as string | null) ?? null,
        code: r.code as string,
        name: r.name as string,
        active: Boolean(r.active),
        enabled: Boolean(r.enabled),
        contactName: (r.contact_name as string | null) ?? null,
        tiles: (r.tiles as Record<string, boolean>) ?? {},
        activePeople: Number(r.active_people ?? 0),
        invitedPeople: Number(r.invited_people ?? 0),
      })),
    };
  }

  setSettings(ctx: RequestContext, body: { enabled?: boolean; rankingEnabled?: boolean; requireMfa?: boolean }) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.set_portal_settings(${orgOf(ctx)}::uuid, ${body.enabled ?? null}::boolean, ${body.rankingEnabled ?? null}::boolean, ${body.requireMfa ?? null}::boolean)`);
      return this.load(db, ctx);
    });
  }

  setParty(ctx: RequestContext, body: { kind: 'supplier' | 'customer'; partyId: string; enabled?: boolean; contactName?: string | null; tiles?: Record<string, boolean> }) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(
        sql`select app.set_portal_party(${orgOf(ctx)}::uuid, ${body.kind}, ${body.partyId}::uuid, ${body.enabled ?? null}::boolean,
                                        ${body.contactName === undefined ? null : (body.contactName ?? '')}::text, ${body.tiles ? JSON.stringify(body.tiles) : null}::jsonb)`,
      );
      return this.load(db, ctx);
    });
  }

  people(ctx: RequestContext, partyId?: string) {
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<Row>(sql`select * from app.list_external_access(${orgOf(ctx)}::uuid, ${partyId ?? null}::uuid)`);
      return { data: r.rows.map(personRow) };
    });
  }

  /** The access row must be in this organisation (else 404, so another organisation's ids are not confirmed); RLS shows only these to the people who may manage them. */
  private async own(db: Db, ctx: RequestContext, id: string) {
    const r = await db.execute<{ id: string }>(sql`select id from public.external_access where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (!r.rows[0]) throw ApiError.notFound('external_access_not_found', 'That access was not found');
  }

  async invite(ctx: RequestContext, body: { partyId: string; email: string; role: 'admin' | 'member'; message?: string }) {
    const id = await this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ id: string }>(
        sql`select app.invite_external_user(${body.partyId}::uuid, ${body.email}, ${body.role}, ${body.message ?? null}) as id`,
      );
      return r.rows[0].id;
    });
    return this.afterInvite(ctx, id);
  }

  async resend(ctx: RequestContext, id: string) {
    await this.database.asUser(ctx, async (db) => {
      await this.own(db, ctx, id);
      await db.execute(sql`select app.resend_external_invitation(${id}::uuid)`);
    });
    return this.afterInvite(ctx, id);
  }

  remove(ctx: RequestContext, id: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.own(db, ctx, id);
      await db.execute(sql`select app.remove_external_access(${id}::uuid, ${reason})`);
      return this.person(db, ctx, id);
    });
  }

  suspend(ctx: RequestContext, id: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.own(db, ctx, id);
      await db.execute(sql`select app.set_external_access_suspended(${id}::uuid, true, ${reason})`);
      return this.person(db, ctx, id);
    });
  }

  restore(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.own(db, ctx, id);
      await db.execute(sql`select app.set_external_access_suspended(${id}::uuid, false, null)`);
      return this.person(db, ctx, id);
    });
  }

  private async person(db: Db, ctx: RequestContext, id: string) {
    const r = await db.execute<Row>(sql`select * from app.list_external_access(${orgOf(ctx)}::uuid) where access_id = ${id}::uuid`);
    if (!r.rows[0]) throw ApiError.notFound('external_access_not_found', 'That access was not found');
    return personRow(r.rows[0]);
  }

  /** The invitation email, after the invitation is committed; a failed email never loses the invitation. */
  private async afterInvite(ctx: RequestContext, id: string) {
    const { person, orgName, inviter, message } = await this.database.asUser(ctx, async (db) => {
      const person = await this.person(db, ctx, id);
      const org = await db.execute<{ name: string }>(sql`select name from public.organisations where id = ${orgOf(ctx)}::uuid`);
      const me = await db.execute<{ name: string | null }>(
        sql`select nullif(trim(coalesce(first_name, '') || ' ' || coalesce(surname, '')), '') as name from public.profiles where id = ${ctx.user.id}::uuid`,
      );
      const msg = await db.execute<{ invite_message: string | null }>(sql`select invite_message from public.external_access where id = ${id}::uuid`);
      return { person, orgName: org.rows[0]?.name ?? 'your customer', inviter: me.rows[0]?.name ?? null, message: msg.rows[0]?.invite_message ?? null };
    });
    const email = await this.mailer.send(person.email, orgName, fetch, {
      inviterName: inviter,
      message,
      expiresAt: person.inviteExpiresAt,
      portalParty: person.partyName,
    });
    return { person, email };
  }
}
