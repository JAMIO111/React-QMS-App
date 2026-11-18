import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { FileLinkSigner } from '../files/file-links';
import { InvitationMailer } from '../members/invitation-mailer.service';
import { personRow } from './external-access.service';

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

const accessRow = (r: Row) => ({
  id: r.access_id as string,
  organisationId: r.organisation_id as string,
  organisationName: r.organisation_name as string,
  partyId: r.party_id as string,
  partyKind: r.party_kind as 'supplier' | 'customer',
  partyName: r.party_name as string,
  role: r.role as 'admin' | 'member',
  contactName: (r.contact_name as string | null) ?? null,
  mfaRequired: Boolean(r.mfa_required),
});

/**
 * The external person's side (docs/external-portal-plan.md PT1). Everything is a database function that reads the party from the person's own access
 * row, never from the request. PT1 holds the foundation: where the person has access, accepting an invitation, an (empty) home, and a party admin's
 * own colleagues. Shared records, responses and performance arrive in later slices.
 */
@Injectable()
export class PortalService {
  constructor(
    private readonly database: DatabaseService,
    private readonly mailer: InvitationMailer,
    private readonly signer: FileLinkSigner,
  ) {}

  private access(db: Db) {
    return db.execute<Row>(sql`select * from app.my_portal_access()`);
  }

  me(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => ({ data: (await this.access(db)).rows.map(accessRow) }));
  }

  invitations(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<Row>(sql`select * from app.my_portal_invitations()`);
      return {
        data: r.rows.map((i) => ({
          id: i.access_id as string,
          organisationId: i.organisation_id as string,
          organisationName: i.organisation_name as string,
          partyKind: i.party_kind as 'supplier' | 'customer',
          partyName: i.party_name as string,
          role: i.role as 'admin' | 'member',
          invitedBy: (i.invited_by_name as string | null) ?? null,
          message: (i.message as string | null) ?? null,
          expiresAt: iso(i.expires_at),
          expired: Boolean(i.expired),
        })),
      };
    });
  }

  accept(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.accept_portal_invitation(${id}::uuid)`);
      return { data: (await this.access(db)).rows.map(accessRow) };
    });
  }

  private shareItem(r: Row) {
    return {
      id: r.share_id as string,
      kind: r.kind as 'ncr' | 'capa',
      reference: r.reference as string,
      title: r.title as string,
      status: r.status as string,
      sharedAt: iso(r.shared_at),
      comments: Number(r.comments ?? 0),
      newComments: Number(r.new_comments ?? 0),
      viewed: Boolean(r.viewed),
      lastCommentAt: iso(r.last_comment_at),
    };
  }

  private shares(db: Db, ctx: RequestContext) {
    return db.execute<Row>(sql`select * from app.portal_list_shares(${ctx.organisationId}::uuid)`);
  }

  async home(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const mine = (await this.access(db)).rows.map(accessRow).find((a) => a.organisationId === ctx.organisationId);
      if (!mine) throw ApiError.notFound('organisation_not_found', 'Organisation not found');
      const items = (await this.shares(db, ctx)).rows.map((r) => this.shareItem(r));
      const scars = (await this.scarRows(db, ctx)).map((r) => this.scarItem(r));
      // What needs the person's attention: SCARs awaiting their response, and records shared with them not yet opened or with something new said.
      return {
        access: mine,
        attention: items.filter((i) => !i.viewed || i.newComments > 0),
        shared: items.length,
        scarsAwaiting: scars.filter((c) => c.awaitingResponse),
        scars: scars.length,
      };
    });
  }

  private scarItem(r: Row) {
    return {
      id: r.scar_id as string,
      reference: r.reference as string,
      title: r.title as string,
      severity: r.severity as 'minor' | 'major' | 'critical',
      status: r.status as string,
      issuedAt: iso(r.issued_at),
      responseDueOn: r.response_due_on ? (r.response_due_on as string).slice(0, 10) : null,
      awaitingResponse: Boolean(r.awaiting_response),
      overdue: Boolean(r.overdue),
      extensionWaiting: Boolean(r.extension_waiting),
      responses: Number(r.responses ?? 0),
    };
  }

  private async scarRows(db: Db, ctx: RequestContext) {
    return (await db.execute<Row>(sql`select * from app.portal_list_scars(${ctx.organisationId}::uuid)`)).rows;
  }

  listScars(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => ({ data: (await this.scarRows(db, ctx)).map((r) => this.scarItem(r)) }));
  }

  private async scarDetail(db: Db, id: string) {
    const r = await db.execute<{ scar: unknown }>(sql`select app.portal_get_scar(${id}::uuid) as scar`);
    return { id, scar: r.rows[0].scar };
  }

  /** The SCAR as the supplier sees it; someone else's SCAR, a draft and another organisation's are all 404 (the database raises it). */
  getScar(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.scarDetail(db, id));
  }

  acknowledgeScar(ctx: RequestContext, id: string, note: string | null) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.portal_acknowledge_scar(${id}::uuid, ${note})`);
      return this.scarDetail(db, id);
    });
  }

  respondScar(
    ctx: RequestContext,
    id: string,
    b: { rootCause: string; containment?: string; correctiveAction: string; preventiveAction?: string; plannedCompletionOn?: string | null; extentOfCondition?: string; escapePoint?: string; responsibleName?: string; rootCauseMethod?: string | null },
  ) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(
        sql`select app.portal_respond_scar(${id}::uuid, ${b.rootCause}, ${b.containment ?? null}, ${b.correctiveAction}, ${b.preventiveAction ?? null}, ${b.plannedCompletionOn ?? null}::date,
              ${b.extentOfCondition ?? null}, ${b.escapePoint ?? null}, ${b.responsibleName ?? null}, ${b.rootCauseMethod ?? null})`,
      );
      return this.scarDetail(db, id);
    });
  }

  requestScarExtension(ctx: RequestContext, id: string, b: { newDueOn: string; reason: string }) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.portal_request_scar_extension(${id}::uuid, ${b.newDueOn}::date, ${b.reason})`);
      return this.scarDetail(db, id);
    });
  }

  /** The database finds the request through a SCAR the caller may see (an unknown or foreign id is a 404) and answers with that SCAR's id. */
  withdrawScarExtension(ctx: RequestContext, extensionId: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ scar_id: string }>(sql`select app.portal_withdraw_scar_extension(${extensionId}::uuid, ${reason}) as scar_id`);
      return this.scarDetail(db, r.rows[0].scar_id);
    });
  }

  /** A file name made safe for a storage path: no slashes, no dot runs, no control characters. */
  private safeName(name: string) {
    const clean = name.replace(/[\\/]/g, '_').replace(/\.{2,}/g, '.').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return clean.slice(0, 120) || 'file';
  }

  /** The path is chosen here, never by the browser; the database says whether this person may add to this SCAR now (404 when it is not theirs). */
  async scarUploadLink(ctx: RequestContext, scarId: string, fileName: string) {
    if (!this.signer.enabled) throw new ApiError(503, 'file_storage_unavailable', 'File links are not set up on this server yet');
    const path = `${ctx.organisationId}/scar/${scarId}/${randomUUID()}-${this.safeName(fileName)}`;
    await this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.portal_get_scar(${scarId}::uuid)`); // 404 unless the SCAR is theirs
      const ok = await db.execute<{ ok: boolean }>(sql`select app.portal_scar_upload_allowed(${scarId}::uuid, ${path}) as ok`);
      if (!ok.rows[0].ok) throw new ApiError(403, 'file_not_allowed', 'Files can be added only while a response is awaited, and at most ten can wait to be sent');
    });
    const signed = await this.signer.signUpload('scar-files', path);
    return { bucket: 'scar-files', path, token: signed.token, signedUrl: signed.signedUrl };
  }

  addScarFile(ctx: RequestContext, scarId: string, b: { path: string; fileName: string; contentType?: string; sizeBytes: number }) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.portal_add_scar_file(${scarId}::uuid, ${b.path}, ${b.fileName}, ${b.contentType ?? null}, ${b.sizeBytes}::bigint)`);
      return this.scarDetail(db, scarId);
    });
  }

  removeScarFile(ctx: RequestContext, fileId: string) {
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ scar_id: string }>(sql`select app.portal_remove_scar_file(${fileId}::uuid) as scar_id`);
      return this.scarDetail(db, r.rows[0].scar_id);
    });
  }

  async scarFileLink(ctx: RequestContext, fileId: string) {
    if (!this.signer.enabled) throw new ApiError(503, 'file_storage_unavailable', 'File links are not set up on this server yet');
    const f = await this.database.asUser(ctx, async (db) => (await db.execute<{ storage_path: string; file_name: string }>(sql`select * from app.portal_scar_file_path(${fileId}::uuid)`)).rows[0]);
    const seconds = 600;
    const url = await this.signer.signDownload('scar-files', f.storage_path, seconds, f.file_name);
    if (!url) throw ApiError.notFound('file_not_found', 'File not found');
    return { url, expiresIn: seconds, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
  }

  listShares(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => ({ data: (await this.shares(db, ctx)).rows.map((r) => this.shareItem(r)) }));
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

  private async thread(db: Db, shareId: string) {
    const r = await db.execute<Row>(sql`select * from app.portal_share_comments(${shareId}::uuid)`);
    return r.rows.map((c) => this.commentRow(c));
  }

  /** One shared record as the party sees it (named fields only), its conversation, and "seen" recorded for the person. */
  getShare(ctx: RequestContext, shareId: string) {
    return this.database.asUser(ctx, async (db) => {
      const item = (await this.shares(db, ctx)).rows.find((r) => r.share_id === shareId);
      if (!item) throw ApiError.notFound('share_not_found', 'That record is not shared with you');
      const kind = item.kind as 'ncr' | 'capa';
      const rec = await db.execute<{ record: unknown }>(
        kind === 'ncr' ? sql`select app.portal_get_ncr(${shareId}::uuid) as record` : sql`select app.portal_get_capa(${shareId}::uuid) as record`,
      );
      const comments = await this.thread(db, shareId);
      await db.execute(sql`select app.portal_mark_viewed(${shareId}::uuid)`);
      return { id: shareId, kind, record: rec.rows[0].record, comments, newComments: Number(item.new_comments ?? 0) };
    });
  }

  comment(ctx: RequestContext, shareId: string, body: string) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.add_portal_comment(${shareId}::uuid, ${body})`);
      return { data: await this.thread(db, shareId) };
    });
  }

  withdrawComment(ctx: RequestContext, commentId: string) {
    return this.database.asUser(ctx, async (db) => {
      // The database decides: only your own comment, within ten minutes, in a share that is still yours (otherwise 404 / a message).
      await db.execute(sql`select app.withdraw_portal_comment(${commentId}::uuid)`);
      return { ok: true };
    });
  }

  people(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<Row>(sql`select * from app.list_external_access(${ctx.organisationId}::uuid, ${ctx.portal!.partyId}::uuid)`);
      return { data: r.rows.map(personRow) };
    });
  }

  /** One of the party's own people; anyone else's id is a 404. */
  private async ownPerson(db: Db, ctx: RequestContext, id: string) {
    const r = await db.execute<Row>(
      sql`select * from app.list_external_access(${ctx.organisationId}::uuid, ${ctx.portal!.partyId}::uuid) where access_id = ${id}::uuid`,
    );
    if (!r.rows[0]) throw ApiError.notFound('external_access_not_found', 'That person was not found');
    return personRow(r.rows[0]);
  }

  async invite(ctx: RequestContext, body: { email: string; message?: string }) {
    const id = await this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ id: string }>(
        sql`select app.invite_external_user(${ctx.portal!.partyId}::uuid, ${body.email}, 'member', ${body.message ?? null}) as id`,
      );
      return r.rows[0].id;
    });
    return this.afterInvite(ctx, id);
  }

  async resend(ctx: RequestContext, id: string) {
    await this.database.asUser(ctx, async (db) => {
      await this.ownPerson(db, ctx, id);
      await db.execute(sql`select app.resend_external_invitation(${id}::uuid)`);
    });
    return this.afterInvite(ctx, id);
  }

  remove(ctx: RequestContext, id: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.ownPerson(db, ctx, id);
      await db.execute(sql`select app.remove_external_access(${id}::uuid, ${reason})`);
      return this.ownPerson(db, ctx, id);
    });
  }

  private async afterInvite(ctx: RequestContext, id: string) {
    const { person, orgName, inviter } = await this.database.asUser(ctx, async (db) => {
      const person = await this.ownPerson(db, ctx, id);
      const mine = (await this.access(db)).rows.map(accessRow).find((a) => a.organisationId === ctx.organisationId);
      const me = await db.execute<{ name: string | null }>(
        sql`select nullif(trim(coalesce(first_name, '') || ' ' || coalesce(surname, '')), '') as name from public.profiles where id = ${ctx.user.id}::uuid`,
      );
      return { person, orgName: mine?.organisationName ?? 'your customer', inviter: me.rows[0]?.name ?? null };
    });
    const email = await this.mailer.send(person.email, orgName, fetch, { inviterName: inviter, expiresAt: person.inviteExpiresAt, portalParty: person.partyName });
    return { person, email };
  }
}
