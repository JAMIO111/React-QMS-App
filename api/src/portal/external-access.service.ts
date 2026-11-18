import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { InvitationMailer } from '../members/invitation-mailer.service';
import { PortalMailer } from './portal-mailer.service';

type Row = Record<string, unknown>;
const orgOf = (ctx: RequestContext) => {
  if (!ctx.organisationId) throw new Error('organisation-scoped route without an organisation');
  return ctx.organisationId;
};
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export type ShareKind = 'ncr' | 'capa' | 'document' | 'quality_alert';

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
    private readonly portalMailer: PortalMailer,
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
  // ---- Sharing records with a party (PT2) ----

  private shareRow(r: Row) {
    return {
      id: r.share_id as string,
      partyId: r.party_id as string,
      partyKind: r.party_kind as 'supplier' | 'customer',
      partyName: r.party_name as string,
      sharedAt: iso(r.shared_at),
      sharedBy: (r.shared_by_name as string | null) ?? null,
      withdrawnAt: iso(r.withdrawn_at),
      withdrawnReason: (r.withdrawn_reason as string | null) ?? null,
      viewers: Number(r.viewers ?? 0),
      firstViewedAt: iso(r.first_viewed_at),
      lastViewedAt: iso(r.last_viewed_at),
      comments: Number(r.comments ?? 0),
      externalComments: Number(r.external_comments ?? 0),
    };
  }

  /** The card on a record: who it is shared with and how they have used it, and who it could still be shared with. */
  private async sharesOf(db: Db, kind: ShareKind, recordId: string) {
    const shares = await db.execute<Row>(sql`select * from app.list_portal_shares(${kind}, ${recordId}::uuid)`);
    const eligible = await db.execute<Row>(sql`select * from app.portal_eligible_parties(${kind}, ${recordId}::uuid)`);
    const acks = new Map<string, Row>();
    if (kind === 'document' || kind === 'quality_alert') {
      const summary = await db.execute<Row>(sql`select * from app.portal_ack_summary(${kind}, ${recordId}::uuid)`);
      for (const a of summary.rows) acks.set(a.share_id as string, a);
    }
    return {
      data: shares.rows.map((r) => {
        const a = acks.get(r.share_id as string);
        return { ...this.shareRow(r), acknowledgement: a ? { acknowledged: Number(a.acknowledged), people: Number(a.people), subject: a.subject_label as string } : null };
      }),
      eligible: eligible.rows.map((r) => ({ partyId: r.party_id as string, partyKind: r.party_kind as 'supplier' | 'customer', partyName: r.party_name as string })),
    };
  }

  shares(ctx: RequestContext, kind: ShareKind, recordId: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.ownRecord(db, ctx, kind, recordId);
      return this.sharesOf(db, kind, recordId);
    });
  }

  /** The record must be in this organisation (404 otherwise, so another organisation's records are not confirmed). */
  private async ownRecord(db: Db, ctx: RequestContext, kind: ShareKind, recordId: string) {
    const org = orgOf(ctx);
    const r = await db.execute<{ id: string }>(
      kind === 'ncr'
        ? sql`select id from public.nonconformances where id = ${recordId}::uuid and organisation_id = ${org}::uuid`
        : kind === 'capa'
          ? sql`select id from public.capas where id = ${recordId}::uuid and organisation_id = ${org}::uuid`
          : kind === 'document'
            ? sql`select id from public.documents where id = ${recordId}::uuid and organisation_id = ${org}::uuid`
            : sql`select id from public.quality_alerts where id = ${recordId}::uuid and organisation_id = ${org}::uuid`,
    );
    if (!r.rows[0]) throw ApiError.notFound('record_not_found', 'That record was not found');
  }

  async share(ctx: RequestContext, body: { kind: ShareKind; recordId: string; partyId: string }) {
    const shareId = await this.database.asUser(ctx, async (db) => {
      await this.ownRecord(db, ctx, body.kind, body.recordId);
      const r = await db.execute<{ id: string }>(sql`select app.share_with_portal(${body.kind}, ${body.recordId}::uuid, ${body.partyId}::uuid) as id`);
      return r.rows[0].id;
    });
    const result = await this.database.asUser(ctx, (db) => this.sharesOf(db, body.kind, body.recordId));
    const email = await this.tellParty(ctx, shareId, 'shared');
    return { ...result, email };
  }

  /** The share must be in this organisation (404 otherwise, so other organisations' ids are not confirmed); returns what the record is. */
  private async ownShare(db: Db, ctx: RequestContext, id: string) {
    const r = await db.execute<{ record_kind: ShareKind; record_id: string }>(
      sql`select record_kind, coalesce(nonconformance_id, capa_id, document_id, quality_alert_id) as record_id from public.portal_shares where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`,
    );
    if (!r.rows[0]) throw ApiError.notFound('share_not_found', 'That share was not found');
    return r.rows[0];
  }

  withdrawShare(ctx: RequestContext, id: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      const record = await this.ownShare(db, ctx, id);
      await db.execute(sql`select app.withdraw_portal_share(${id}::uuid, ${reason})`);
      return this.sharesOf(db, record.record_kind, record.record_id);
    });
  }

  /** Requests for closure confirmation on a share, as staff see them. */
  private async closuresOf(db: Db, shareId: string) {
    const r = await db.execute<{ c: unknown }>(sql`select app.portal_share_closures(${shareId}::uuid) as c`);
    return { data: r.rows[0].c as unknown[] };
  }

  closures(ctx: RequestContext, shareId: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.ownShare(db, ctx, shareId);
      return this.closuresOf(db, shareId);
    });
  }

  async requestClosure(ctx: RequestContext, shareId: string, note: string | null) {
    const result = await this.database.asUser(ctx, async (db) => {
      await this.ownShare(db, ctx, shareId);
      await db.execute(sql`select app.request_portal_closure(${shareId}::uuid, ${note})`);
      return this.closuresOf(db, shareId);
    });
    const email = await this.tellParty(ctx, shareId, 'closure', note ?? undefined);
    return { ...result, email };
  }

  withdrawClosure(ctx: RequestContext, requestId: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      const found = await db.execute<{ share_id: string }>(
        sql`select share_id from public.portal_closure_requests where id = ${requestId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`,
      );
      if (!found.rows[0]) throw ApiError.notFound('request_not_found', 'That request was not found');
      await db.execute(sql`select app.withdraw_portal_closure(${requestId}::uuid, ${reason})`);
      return this.closuresOf(db, found.rows[0].share_id);
    });
  }

  /** The files shared from a lot, and the customers it is for (PT5f). 404 unless the lot is this organisation's and the caller may see it. */
  private async evidenceOf(db: Db, lotId: string) {
    const files = await db.execute<Row>(sql`select * from app.list_lot_evidence(${lotId}::uuid)`);
    const customers = await db.execute<Row>(sql`select * from app.lot_evidence_customers(${lotId}::uuid)`);
    return {
      data: files.rows.map((f) => ({
        id: f.file_id as string,
        customerId: f.customer_id as string,
        customerName: f.customer_name as string,
        kind: f.kind as 'certificate_of_conformance' | 'inspection_report' | 'other',
        description: (f.description as string | null) ?? null,
        fileName: f.file_name as string,
        sizeBytes: Number(f.size_bytes),
        storagePath: f.storage_path as string,
        addedAt: iso(f.added_at),
        addedBy: f.added_by as string,
        removedAt: iso(f.removed_at),
        removeReason: (f.remove_reason as string | null) ?? null,
      })),
      customers: customers.rows.map((c) => ({ id: c.customer_id as string, name: c.customer_name as string })),
    };
  }

  lotEvidence(ctx: RequestContext, lotId: string) {
    return this.database.asUser(ctx, async (db) => {
      const ok = await db.execute(sql`select 1 from public.lots where id = ${lotId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (ok.rows.length === 0) throw ApiError.notFound('lot_not_found', 'That lot was not found');
      return this.evidenceOf(db, lotId);
    });
  }

  addLotEvidence(ctx: RequestContext, lotId: string, b: { customerId: string; kind: string; description?: string | null; path: string; fileName: string; contentType?: string | null; sizeBytes: number }) {
    return this.database.asUser(ctx, async (db) => {
      const ok = await db.execute(sql`select 1 from public.lots where id = ${lotId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (ok.rows.length === 0) throw ApiError.notFound('lot_not_found', 'That lot was not found');
      await db.execute(sql`select app.add_lot_evidence(${lotId}::uuid, ${b.customerId}::uuid, ${b.kind}, ${b.description ?? null}, ${b.path}, ${b.fileName}, ${b.contentType ?? null}, ${b.sizeBytes}::bigint)`);
      return this.evidenceOf(db, lotId);
    });
  }

  removeLotEvidence(ctx: RequestContext, fileId: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      const found = await db.execute<{ lot_id: string }>(sql`select lot_id from public.lot_evidence_files where id = ${fileId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!found.rows[0]) throw ApiError.notFound('file_not_found', 'That file was not found');
      await db.execute(sql`select app.remove_lot_evidence(${fileId}::uuid, ${reason})`);
      return this.evidenceOf(db, found.rows[0].lot_id);
    });
  }

  /** Who in the party acknowledged a shared document or alert, and which revision they acknowledged. */
  acknowledgements(ctx: RequestContext, shareId: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.ownShare(db, ctx, shareId);
      const r = await db.execute<Row>(sql`select * from app.portal_share_acknowledgements(${shareId}::uuid)`);
      return {
        data: r.rows.map((k) => ({ person: k.person_name as string, subject: k.subject_label as string, note: (k.note as string | null) ?? null, acknowledgedAt: iso(k.acknowledged_at), current: Boolean(k.current) })),
      };
    });
  }

  private commentRow(r: Row) {
    return {
      id: r.comment_id as string,
      side: r.side as 'staff' | 'external',
      author: r.author_name as string,
      body: (r.body as string | null) ?? null,
      createdAt: iso(r.created_at),
      withdrawn: Boolean(r.withdrawn),
      mine: Boolean(r.mine),
      canWithdraw: Boolean(r.can_withdraw),
    };
  }

  comments(ctx: RequestContext, shareId: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.ownShare(db, ctx, shareId);
      const r = await db.execute<Row>(sql`select * from app.portal_share_comments(${shareId}::uuid)`);
      return { data: r.rows.map((c) => this.commentRow(c)) };
    });
  }

  async comment(ctx: RequestContext, shareId: string, body: string) {
    const result = await this.database.asUser(ctx, async (db) => {
      await this.ownShare(db, ctx, shareId);
      await db.execute(sql`select app.add_portal_comment(${shareId}::uuid, ${body})`);
      const r = await db.execute<Row>(sql`select * from app.portal_share_comments(${shareId}::uuid)`);
      return { data: r.rows.map((c) => this.commentRow(c)) };
    });
    const email = await this.tellParty(ctx, shareId, 'comment', body);
    return { ...result, email };
  }

  withdrawComment(ctx: RequestContext, commentId: string) {
    return this.database.asUser(ctx, async (db) => {
      const found = await db.execute<{ share_id: string }>(
        sql`select share_id from public.portal_comments where id = ${commentId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`,
      );
      if (!found.rows[0]) throw ApiError.notFound('comment_not_found', 'That comment was not found');
      await db.execute(sql`select app.withdraw_portal_comment(${commentId}::uuid)`);
      const r = await db.execute<Row>(sql`select * from app.portal_share_comments(${found.rows[0].share_id}::uuid)`);
      return { data: r.rows.map((c) => this.commentRow(c)) };
    });
  }

  /** Email the party's active people that something was shared or said (best effort; never undoes the action). */
  private async tellParty(ctx: RequestContext, shareId: string, what: 'shared' | 'comment' | 'closure', text?: string) {
    try {
      const info = await this.database.asUser(ctx, async (db) => {
        const people = await db.execute<{ email: string; name: string | null }>(sql`select email, name from app.portal_share_recipients(${shareId}::uuid)`);
        const rec = await db.execute<{ reference: string; title: string; org_name: string; kind: string; party_name: string }>(
          sql`select coalesce(n.reference, c.reference, d.number, qa.reference) as reference, coalesce(n.title, c.title, d.title, qa.title) as title, o.name as org_name, x.record_kind as kind,
                     coalesce(sup.name, cus.name) as party_name
                from public.portal_shares x
                join public.organisations o on o.id = x.organisation_id
                join public.portal_parties p on p.id = x.party_id
                left join public.suppliers sup on sup.id = p.supplier_id
                left join public.customers cus on cus.id = p.customer_id
                left join public.nonconformances n on n.id = x.nonconformance_id
                left join public.capas c on c.id = x.capa_id
                left join public.documents d on d.id = x.document_id
                left join public.quality_alerts qa on qa.id = x.quality_alert_id
               where x.id = ${shareId}::uuid`,
        );
        return { people: people.rows, rec: rec.rows[0] };
      });
      if (!info.rec) return { attempted: 0, sent: 0 };
      const what1 = { capa: '8D', document: 'document', quality_alert: 'quality alert' }[info.rec.kind] ?? 'non-conformance';
      const label = `${info.rec.reference} — ${info.rec.title}`;
      return await this.portalMailer.send({
        to: info.people.map((p) => ({ email: p.email, name: p.name })),
        subject:
          what === 'shared'
            ? `${info.rec.org_name} shared a ${what1} with you: ${info.rec.reference}`
            : what === 'closure'
              ? `${info.rec.org_name} asks you to confirm closure: ${info.rec.reference}`
              : `${info.rec.org_name} wrote to you about ${info.rec.reference}`,
        heading: what === 'shared' ? `${info.rec.org_name} shared a ${what1} with you` : what === 'closure' ? `Please confirm closure` : `New comment from ${info.rec.org_name}`,
        paragraphs: [
          what === 'shared'
            ? `${info.rec.org_name} has shared ${label} with ${info.rec.party_name}. You can see the details and reply on your portal.`
            : what === 'closure'
              ? `${info.rec.org_name} believes ${label} can be closed and asks you to confirm. Open it on your portal to confirm, or to say what is still wrong.`
              : `${info.rec.org_name} has written a comment on ${label}.`,
        ],
        quote: (what === 'comment' || what === 'closure') && text ? { text: text.length > 500 ? `${text.slice(0, 500)}…` : text, by: info.rec.org_name } : undefined,
        path: `/portal/shared/${shareId}?org=${orgOf(ctx)}`,
        button: 'Open in the portal',
        footerWho: info.rec.org_name,
      });
    } catch {
      return { attempted: 0, sent: 0 };
    }
  }
}
