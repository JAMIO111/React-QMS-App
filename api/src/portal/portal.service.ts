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
      kind: r.kind as 'ncr' | 'capa' | 'document' | 'quality_alert',
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
      const counts = await this.actionCounts(db, ctx);
      const scars = (await this.scarRows(db, ctx)).map((r) => this.scarItem(r, counts));
      const pending = new Set((await db.execute<{ share_id: string }>(sql`select share_id from app.portal_pending_acknowledgements(${ctx.organisationId}::uuid)`)).rows.map((r) => r.share_id));
      const closing = new Set((await db.execute<{ share_id: string }>(sql`select share_id from app.portal_pending_closures(${ctx.organisationId}::uuid)`)).rows.map((r) => r.share_id));
      const approvals = ctx.portal?.partyKind === 'customer'
        ? (await db.execute<{ request_id: string }>(sql`select request_id from app.portal_list_change_approvals(${ctx.organisationId}::uuid) where can_decide`)).rows.length
        : 0;
      const ppaps = ctx.portal?.partyKind === 'customer'
        ? (await db.execute<{ request_id: string }>(sql`select request_id from app.portal_list_ppaps(${ctx.organisationId}::uuid) where can_decide`)).rows.length
        : 0;
      const packages = ctx.portal?.partyKind === 'supplier'
        ? (await db.execute<{ request_id: string }>(sql`select request_id from app.portal_list_ppap_packages(${ctx.organisationId}::uuid) where can_edit`)).rows.length
        : 0;
      // What needs the person's attention: SCARs awaiting their response, and records shared with them not yet opened or with something new said.
      return {
        access: mine,
        attention: items.filter((i) => !i.viewed || i.newComments > 0 || pending.has(i.id) || closing.has(i.id)).map((i) => ({ ...i, needsAcknowledgement: pending.has(i.id), needsClosure: closing.has(i.id) })),
        toConfirm: closing.size,
        changesToApprove: approvals,
        ppapsToAnswer: ppaps,
        ppapPackagesToPrepare: packages,
        toAcknowledge: pending.size,
        shared: items.length,
        scarsAwaiting: scars.filter((c) => c.awaitingResponse),
        scarsWithActions: scars.filter((c) => c.openActions > 0),
        scars: scars.length,
      };
    });
  }

  private customerParty(ctx: RequestContext) {
    const party = ctx.portal;
    if (!party || party.partyKind !== 'customer') throw ApiError.notFound('complaints_unavailable', 'Complaints are raised by customers');
    return party.partyId;
  }

  private anyParty(ctx: RequestContext) {
    const party = ctx.portal;
    if (!party) throw ApiError.notFound('change_requests_unavailable', 'Change requests are sent by customers and suppliers');
    return party.partyId;
  }

  /** Files staff shared with the customer from a lot (PT5f). */
  evidence(ctx: RequestContext) {
    const party = this.customerParty(ctx);
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<Row>(sql`select * from app.portal_list_evidence(${ctx.organisationId}::uuid, ${party}::uuid)`);
      return {
        data: r.rows.map((f) => ({
          id: f.file_id as string,
          lotNumber: f.lot_number as string,
          partNumber: f.part_number as string,
          partName: f.part_name as string,
          kind: f.kind as 'certificate_of_conformance' | 'inspection_report' | 'other',
          description: (f.description as string | null) ?? null,
          fileName: f.file_name as string,
          sizeBytes: Number(f.size_bytes),
          addedAt: iso(f.added_at),
        })),
      };
    });
  }

  async evidenceLink(ctx: RequestContext, fileId: string) {
    if (!this.signer.enabled) throw new ApiError(503, 'file_storage_unavailable', 'File links are not set up on this server yet');
    const f = await this.database.asUser(ctx, async (db) => (await db.execute<{ storage_path: string; file_name: string }>(sql`select * from app.portal_evidence_file_path(${fileId}::uuid)`)).rows[0]);
    const seconds = 600;
    const url = await this.signer.signDownload('lot-evidence', f.storage_path, seconds, f.file_name);
    if (!url) throw ApiError.notFound('file_not_found', 'File not found');
    return { url, expiresIn: seconds, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
  }

  /** A customer's own quality figures (PT5d): counts and averages the database works out for their party only. */
  customerFigures(ctx: RequestContext, days?: string) {
    const party = this.customerParty(ctx);
    const n = days === undefined || days === '' ? 90 : Number(days);
    if (![30, 90, 365].includes(n)) throw ApiError.badRequest('invalid_period', 'Choose 30, 90 or 365 days');
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ r: Record<string, unknown> }>(sql`select app.portal_get_customer_figures(${ctx.organisationId}::uuid, ${party}::uuid, ${n}::int) as r`);
      return r.rows[0].r;
    });
  }

  /** A customer's own complaints (PT5a): a plain status from the non-conformance's stage, named fields only. */
  listComplaints(ctx: RequestContext) {
    const party = this.customerParty(ctx);
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<Row>(sql`select * from app.portal_list_complaints(${ctx.organisationId}::uuid, ${party}::uuid)`);
      const files = await db.execute<Row>(sql`select * from app.portal_complaint_files(${ctx.organisationId}::uuid, ${party}::uuid)`);
      return {
        data: r.rows.map((c) => ({
          files: files.rows
            .filter((f) => f.complaint_id === c.complaint_id)
            .map((f) => ({ id: f.file_id as string, name: f.file_name as string, sizeBytes: Number(f.size_bytes), addedAt: iso(f.added_at), mine: Boolean(f.mine), canRemove: Boolean(f.can_remove) })),
          id: c.complaint_id as string,
          reference: c.reference as string,
          title: c.title as string,
          description: c.description as string,
          status: c.status as 'received' | 'in_progress' | 'closed' | 'cancelled',
          raisedAt: iso(c.raised_at),
          raisedByMe: Boolean(c.raised_by_me),
          partNumber: (c.part_number as string | null) ?? null,
          partName: (c.part_name as string | null) ?? null,
          quantity: c.quantity === null ? null : Number(c.quantity),
          lot: (c.lot_number as string | null) ?? null,
          customerReference: (c.customer_reference as string | null) ?? null,
          detectedOn: (c.detected_on as string | null) ?? null,
          shareId: (c.share_id as string | null) ?? null,
        })),
      };
    });
  }

  raiseComplaint(ctx: RequestContext, b: { title: string; description: string; partId?: string | null; quantity?: number | null; lot?: string | null; customerReference?: string | null; detectedOn?: string | null; clientKey?: string | null }) {
    const party = this.customerParty(ctx);
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ r: { id: string; created: boolean } }>(
        sql`select app.portal_raise_complaint(${ctx.organisationId}::uuid, ${party}::uuid, ${b.title}, ${b.description}, ${b.partId ?? null}::uuid, ${b.quantity ?? null}::numeric,
              ${b.lot ?? null}, ${b.customerReference ?? null}, ${b.detectedOn ?? null}::date, ${b.clientKey ?? null}) as r`,
      );
      return r.rows[0].r;
    });
  }

  /** The path is chosen here, never by the browser; the database says whether the complaint is theirs and still open to files. */
  async complaintUploadLink(ctx: RequestContext, complaintId: string, fileName: string) {
    if (!this.signer.enabled) throw new ApiError(503, 'file_storage_unavailable', 'File links are not set up on this server yet');
    // The complaint table is not readable by the person; the folder comes from the one function that may say (404 unless the complaint is theirs).
    const folder = await this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ ncr: string | null }>(sql`select app.portal_complaint_folder(${complaintId}::uuid) as ncr`);
      return r.rows[0]?.ncr ?? null;
    });
    if (!folder) throw ApiError.notFound('complaint_not_found', 'Complaint not found');
    const path = `${ctx.organisationId}/ncr/${folder}/${randomUUID()}-${this.safeName(fileName)}`;
    await this.database.asUser(ctx, async (db) => {
      const ok = await db.execute<{ ok: boolean }>(sql`select app.portal_complaint_upload_allowed(${complaintId}::uuid, ${path}) as ok`);
      if (!ok.rows[0].ok) throw new ApiError(403, 'file_not_allowed', 'Files can be added only until we start work on the complaint, and at most ten');
    });
    const signed = await this.signer.signUpload('nc-files', path);
    return { bucket: 'nc-files', path, token: signed.token, signedUrl: signed.signedUrl };
  }

  addComplaintFile(ctx: RequestContext, complaintId: string, b: { path: string; fileName: string; contentType?: string; sizeBytes: number }) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.portal_add_complaint_file(${complaintId}::uuid, ${b.path}, ${b.fileName}, ${b.contentType ?? null}, ${b.sizeBytes}::bigint)`);
      return { ok: true };
    });
  }

  removeComplaintFile(ctx: RequestContext, fileId: string) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.portal_remove_complaint_file(${fileId}::uuid)`);
      return { ok: true };
    });
  }

  async complaintFileLink(ctx: RequestContext, fileId: string) {
    if (!this.signer.enabled) throw new ApiError(503, 'file_storage_unavailable', 'File links are not set up on this server yet');
    const f = await this.database.asUser(ctx, async (db) => (await db.execute<{ storage_path: string; file_name: string }>(sql`select * from app.portal_complaint_file_path(${fileId}::uuid)`)).rows[0]);
    const seconds = 600;
    const url = await this.signer.signDownload('nc-files', f.storage_path, seconds, f.file_name);
    if (!url) throw ApiError.notFound('file_not_found', 'File not found');
    return { url, expiresIn: seconds, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
  }

  complaintParts(ctx: RequestContext) {
    const party = this.customerParty(ctx);
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<Row>(sql`select * from app.portal_my_parts(${ctx.organisationId}::uuid, ${party}::uuid)`);
      return {
        data: r.rows.map((p) => ({ id: p.part_id as string, partNumber: p.part_number as string, name: p.part_name as string, customerPartNumber: (p.customer_part_number as string | null) ?? null })),
      };
    });
  }

  /** The parts a customer or supplier may name in a change request: the ones we make for a customer, the ones a supplier supplies to us (CH6a). */
  changeParts(ctx: RequestContext) {
    const party = this.anyParty(ctx);
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<Row>(sql`select * from app.portal_change_parts(${ctx.organisationId}::uuid, ${party}::uuid)`);
      return { data: r.rows.map((p) => ({ id: p.part_id as string, partNumber: p.part_number as string, name: p.part_name as string, theirPartNumber: (p.their_part_number as string | null) ?? null })) };
    });
  }

  /** The party's own change requests (CH6a): a plain status from the change's stage, named fields only. */
  listChangeRequests(ctx: RequestContext) {
    const party = this.anyParty(ctx);
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<Row>(sql`select * from app.portal_list_change_requests(${ctx.organisationId}::uuid, ${party}::uuid)`);
      return {
        data: r.rows.map((c) => ({
          id: c.request_id as string,
          reference: c.reference as string,
          kind: c.kind as 'customer_request' | 'supplier_notice',
          title: c.title as string,
          description: c.description as string,
          status: c.status as 'received' | 'under_review' | 'accepted' | 'done' | 'declined' | 'cancelled',
          raisedAt: iso(c.raised_at),
          raisedByMe: Boolean(c.raised_by_me),
          partNumber: (c.part_number as string | null) ?? null,
          partName: (c.part_name as string | null) ?? null,
          wantedOn: (c.wanted_on as string | null) ?? null,
        })),
      };
    });
  }

  raiseChangeRequest(ctx: RequestContext, b: { title: string; description: string; reason?: string | null; partId?: string | null; wantedOn?: string | null; clientKey?: string | null }) {
    const party = this.anyParty(ctx);
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ r: { id: string; created: boolean } }>(
        sql`select app.portal_raise_change(${ctx.organisationId}::uuid, ${party}::uuid, ${b.title}, ${b.description}, ${b.reason ?? null}, ${b.partId ?? null}::uuid, ${b.wantedOn ?? null}::date, ${b.clientKey ?? null}) as r`,
      );
      return r.rows[0].r;
    });
  }

  /** The changes a customer has been asked to approve (CH6b): named fields only; a withdrawn request is not shown. */
  listChangeApprovals(ctx: RequestContext) {
    this.customerParty(ctx);
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<Row>(sql`select * from app.portal_list_change_approvals(${ctx.organisationId}::uuid)`);
      return {
        data: r.rows.map((c) => ({
          id: c.request_id as string,
          reference: c.reference as string,
          title: c.title as string,
          status: c.status as 'pending' | 'approved' | 'rejected',
          requestedAt: iso(c.requested_at),
          decidedAt: iso(c.decided_at),
          canDecide: Boolean(c.can_decide),
        })),
      };
    });
  }

  getChangeApproval(ctx: RequestContext, id: string) {
    this.customerParty(ctx);
    return this.database.asUser(ctx, async (db) => (await db.execute<{ r: Record<string, unknown> }>(sql`select app.portal_get_change_approval(${id}::uuid) as r`)).rows[0].r);
  }

  /** The customer's answer: it is recorded on the change's own customer-approval record, and nothing else moves. */
  decideChangeApproval(ctx: RequestContext, id: string, b: { approve: boolean; note?: string | null; reference?: string | null }) {
    this.customerParty(ctx);
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.portal_decide_change_approval(${id}::uuid, ${b.approve}, ${b.note ?? null}, ${b.reference ?? null})`);
      return (await db.execute<{ r: Record<string, unknown> }>(sql`select app.portal_get_change_approval(${id}::uuid) as r`)).rows[0].r;
    });
  }

  /** The part approval submissions a customer has been asked to answer (PP4): named fields only; a withdrawn request is not shown. */
  listPpaps(ctx: RequestContext) {
    this.customerParty(ctx);
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<Row>(sql`select * from app.portal_list_ppaps(${ctx.organisationId}::uuid)`);
      return {
        data: r.rows.map((c) => ({
          id: c.request_id as string,
          reference: c.reference as string,
          partNumber: c.part_number as string,
          partName: c.part_name as string,
          theirPartNumber: (c.their_part_number as string | null) ?? null,
          level: Number(c.level),
          status: c.status as 'pending' | 'answered',
          submissionStatus: c.submission_status as string,
          requestedAt: iso(c.requested_at),
          answeredAt: iso(c.answered_at),
          canDecide: Boolean(c.can_decide),
        })),
      };
    });
  }

  getPpap(ctx: RequestContext, id: string) {
    this.customerParty(ctx);
    return this.database.asUser(ctx, async (db) => (await db.execute<{ r: Record<string, unknown> }>(sql`select app.portal_get_ppap(${id}::uuid) as r`)).rows[0].r);
  }

  /** The customer's answer: recorded as the submission's decision, today, by the same rules staff use. */
  decidePpap(ctx: RequestContext, id: string, b: { kind: 'approved' | 'interim_approved' | 'rejected'; note?: string | null; reference?: string | null; expiresOn?: string | null }) {
    this.customerParty(ctx);
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.portal_decide_ppap(${id}::uuid, ${b.kind}, ${b.note ?? null}, ${b.reference ?? null}, ${b.expiresOn ?? null}::date)`);
      return (await db.execute<{ r: Record<string, unknown> }>(sql`select app.portal_get_ppap(${id}::uuid) as r`)).rows[0].r;
    });
  }

  private supplierParty(ctx: RequestContext) {
    const party = ctx.portal;
    if (!party || party.partyKind !== 'supplier') throw ApiError.notFound('ppap_packages_unavailable', 'Part approval packages are asked of suppliers');
    return party.partyId;
  }

  /** The part approval packages staff have asked this supplier to prepare (PP5b): named fields only. */
  listPpapPackages(ctx: RequestContext) {
    this.supplierParty(ctx);
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<Row>(sql`select * from app.portal_list_ppap_packages(${ctx.organisationId}::uuid)`);
      return {
        data: r.rows.map((c) => ({
          id: c.request_id as string,
          reference: c.reference as string,
          partNumber: c.part_number as string,
          partName: c.part_name as string,
          level: Number(c.level),
          status: c.status as 'pending' | 'answered',
          submissionStatus: c.submission_status as string,
          requestedAt: iso(c.requested_at),
          answeredAt: iso(c.answered_at),
          canEdit: Boolean(c.can_edit),
        })),
      };
    });
  }

  getPpapPackage(ctx: RequestContext, id: string) {
    this.supplierParty(ctx);
    return this.database.asUser(ctx, async (db) => (await db.execute<{ r: Record<string, unknown> }>(sql`select app.portal_get_ppap_package(${id}::uuid) as r`)).rows[0].r);
  }

  /** The path is chosen here, never by the browser; the database says whether the package is theirs, still being prepared, and the element is one asked of them. */
  async ppapPackageUploadLink(ctx: RequestContext, requestId: string, elementKey: string, fileName: string) {
    this.supplierParty(ctx);
    if (!this.signer.enabled) throw new ApiError(503, 'file_storage_unavailable', 'File links are not set up on this server yet');
    const folder = await this.database.asUser(ctx, async (db) => (await db.execute<{ f: string }>(sql`select app.portal_ppap_package_folder(${requestId}::uuid) as f`)).rows[0]?.f ?? null);
    if (!folder) throw ApiError.notFound('package_not_found', 'Package not found');
    const path = `${ctx.organisationId}/ppap/${folder}/${randomUUID()}-${this.safeName(fileName)}`;
    await this.database.asUser(ctx, async (db) => {
      const ok = await db.execute<{ ok: boolean }>(sql`select app.portal_ppap_upload_allowed(${requestId}::uuid, ${elementKey}, ${path}) as ok`);
      if (!ok.rows[0].ok) throw new ApiError(403, 'file_not_allowed', 'Files can be added only while you are preparing the package, to an element asked of you, and at most ten to an element');
    });
    const signed = await this.signer.signUpload('ppap-files', path);
    return { bucket: 'ppap-files', path, token: signed.token, signedUrl: signed.signedUrl };
  }

  addPpapPackageFile(ctx: RequestContext, requestId: string, b: { elementKey: string; path: string; fileName: string; contentType?: string; sizeBytes: number }) {
    this.supplierParty(ctx);
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.portal_add_ppap_file(${requestId}::uuid, ${b.elementKey}, ${b.path}, ${b.fileName}, ${b.contentType ?? null}, ${b.sizeBytes}::bigint)`);
      return (await db.execute<{ r: Record<string, unknown> }>(sql`select app.portal_get_ppap_package(${requestId}::uuid) as r`)).rows[0].r;
    });
  }

  removePpapPackageFile(ctx: RequestContext, fileId: string) {
    this.supplierParty(ctx);
    return this.database.asUser(ctx, async (db) => {
      const req = (await db.execute<{ id: string }>(sql`select app.portal_remove_ppap_file(${fileId}::uuid) as id`)).rows[0].id;
      return (await db.execute<{ r: Record<string, unknown> }>(sql`select app.portal_get_ppap_package(${req}::uuid) as r`)).rows[0].r;
    });
  }

  async ppapPackageFileLink(ctx: RequestContext, fileId: string) {
    this.supplierParty(ctx);
    if (!this.signer.enabled) throw new ApiError(503, 'file_storage_unavailable', 'File links are not set up on this server yet');
    const f = await this.database.asUser(ctx, async (db) => (await db.execute<{ storage_path: string; file_name: string }>(sql`select * from app.portal_ppap_package_file_path(${fileId}::uuid)`)).rows[0]);
    const seconds = 600;
    const url = await this.signer.signDownload('ppap-files', f.storage_path, seconds, f.file_name);
    if (!url) throw ApiError.notFound('file_not_found', 'File not found');
    return { url, expiresIn: seconds, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
  }

  /** The supplier submits the package: the database checks every required element has evidence and records it as submitted, exactly as recording it as received does. */
  submitPpapPackage(ctx: RequestContext, requestId: string, note: string | null) {
    this.supplierParty(ctx);
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.portal_submit_ppap_package(${requestId}::uuid, ${note})`);
      return (await db.execute<{ r: Record<string, unknown> }>(sql`select app.portal_get_ppap_package(${requestId}::uuid) as r`)).rows[0].r;
    });
  }

  /** A supplier's own performance (PT4): the database works it out with the staff Performance tab's function and returns named fields only. */
  async performance(ctx: RequestContext, days?: string) {
    const n = days === undefined || days === '' ? 90 : Number(days);
    if (![30, 90, 365].includes(n)) throw ApiError.badRequest('invalid_period', 'Choose 30, 90 or 365 days');
    const party = ctx.portal;
    if (!party || party.partyKind !== 'supplier') throw ApiError.notFound('performance_unavailable', 'Performance is shown to suppliers');
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ r: Record<string, unknown> }>(sql`select app.portal_get_performance(${ctx.organisationId}::uuid, ${party.partyId}::uuid, ${n}::int) as r`);
      return r.rows[0].r;
    });
  }

  /** Open and late actions per SCAR, for the lists and the home page. */
  private async actionCounts(db: Db, ctx: RequestContext) {
    const r = await db.execute<{ scar_id: string; open_actions: number; late_actions: number }>(sql`select * from app.portal_scar_action_counts(${ctx.organisationId}::uuid)`);
    return new Map(r.rows.map((x) => [x.scar_id, { open: Number(x.open_actions), late: Number(x.late_actions) }]));
  }

  private scarItem(r: Row, counts?: Map<string, { open: number; late: number }>) {
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
      openActions: counts?.get(r.scar_id as string)?.open ?? 0,
      lateActions: counts?.get(r.scar_id as string)?.late ?? 0,
    };
  }

  private async scarRows(db: Db, ctx: RequestContext) {
    return (await db.execute<Row>(sql`select * from app.portal_list_scars(${ctx.organisationId}::uuid)`)).rows;
  }

  listScars(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const counts = await this.actionCounts(db, ctx);
      return { data: (await this.scarRows(db, ctx)).map((r) => this.scarItem(r, counts)) };
    });
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

  /** The database checks the caller's own portal access to the action's SCAR (an unknown or foreign id is a 404) and answers with that SCAR's id. */
  completeScarAction(ctx: RequestContext, actionId: string, note: string) {
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ scar_id: string }>(sql`select app.portal_complete_scar_action(${actionId}::uuid, ${note}) as scar_id`);
      return this.scarDetail(db, r.rows[0].scar_id);
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

  /** The register rows of the non-conformances shared with the caller's party (PT6). */
  listNcrs(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<Row>(sql`select * from app.portal_list_ncrs(${ctx.organisationId}::uuid)`);
      return {
        data: r.rows.map((n) => ({
          id: n.share_id as string,
          reference: n.reference as string,
          title: n.title as string,
          stage: n.stage as string,
          severity: n.severity as string,
          detectedAt: n.detected_at ? String(n.detected_at).slice(0, 10) : null,
          partNumber: (n.part_number as string | null) ?? null,
          partName: (n.part_name as string | null) ?? null,
          lotNumber: (n.lot_number as string | null) ?? null,
          quantityAffected: n.quantity_affected === null || n.quantity_affected === undefined ? null : Number(n.quantity_affected),
          customerReference: (n.customer_reference as string | null) ?? null,
          purchaseOrder: (n.purchase_order as string | null) ?? null,
          sharedAt: iso(n.shared_at),
          comments: Number(n.comments ?? 0),
          newComments: Number(n.new_comments ?? 0),
          viewed: Boolean(n.viewed),
          lastCommentAt: iso(n.last_comment_at),
          closurePending: Boolean(n.closure_pending),
        })),
      };
    });
  }

  /** The register rows of the 8Ds shared with the caller's party (PT6). */
  listCapas(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<Row>(sql`select * from app.portal_list_capas(${ctx.organisationId}::uuid)`);
      return {
        data: r.rows.map((c) => ({
          id: c.share_id as string,
          reference: c.reference as string,
          title: c.title as string,
          severity: (c.severity as string | null) ?? null,
          stage: c.stage as string,
          startedAt: iso(c.started_at),
          closedAt: iso(c.closed_at),
          sharedAt: iso(c.shared_at),
          comments: Number(c.comments ?? 0),
          newComments: Number(c.new_comments ?? 0),
          viewed: Boolean(c.viewed),
          lastCommentAt: iso(c.last_comment_at),
          closurePending: Boolean(c.closure_pending),
        })),
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

  private async thread(db: Db, shareId: string) {
    const r = await db.execute<Row>(sql`select * from app.portal_share_comments(${shareId}::uuid)`);
    return r.rows.map((c) => this.commentRow(c));
  }

  /** One shared record as the party sees it (named fields only), its conversation, and "seen" recorded for the person. */
  getShare(ctx: RequestContext, shareId: string) {
    return this.database.asUser(ctx, async (db) => {
      const item = (await this.shares(db, ctx)).rows.find((r) => r.share_id === shareId);
      if (!item) throw ApiError.notFound('share_not_found', 'That record is not shared with you');
      const kind = item.kind as 'ncr' | 'capa' | 'document' | 'quality_alert';
      const rec = await db.execute<{ record: unknown }>(
        kind === 'ncr'
          ? sql`select app.portal_get_ncr(${shareId}::uuid) as record`
          : kind === 'capa'
            ? sql`select app.portal_get_capa(${shareId}::uuid) as record`
            : kind === 'document'
              ? sql`select app.portal_get_document(${shareId}::uuid) as record`
              : sql`select app.portal_get_quality_alert(${shareId}::uuid) as record`,
      );
      const comments = await this.thread(db, shareId);
      await db.execute(sql`select app.portal_mark_viewed(${shareId}::uuid)`);
      const closures = (await db.execute<{ c: unknown[] }>(sql`select app.portal_share_closures(${shareId}::uuid) as c`)).rows[0].c;
      return { id: shareId, kind, record: rec.rows[0].record, comments, newComments: Number(item.new_comments ?? 0), closures };
    });
  }

  /** A customer's answer to a request to confirm closure; the share's record page shows the result. */
  decideClosure(ctx: RequestContext, requestId: string, confirm: boolean, note: string | null) {
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ share_id: string }>(sql`select app.portal_decide_closure(${requestId}::uuid, ${confirm}, ${note}) as share_id`);
      const shareId = r.rows[0].share_id;
      const closures = (await db.execute<{ c: unknown[] }>(sql`select app.portal_share_closures(${shareId}::uuid) as c`)).rows[0].c;
      return { id: shareId, closures };
    });
  }

  /** Acknowledge the document revision in force or the quality alert; the database says who, when and which revision. */
  acknowledgeShare(ctx: RequestContext, shareId: string, note: string | null) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.portal_acknowledge_share(${shareId}::uuid, ${note})`);
      return { ok: true };
    });
  }

  /** A short link (ten minutes) to a file of the document revision in force that was shared with the person's party. */
  async documentFileLink(ctx: RequestContext, shareId: string, fileId: string) {
    const f = await this.database.asUser(ctx, async (db) => (await db.execute<{ storage_path: string; file_name: string }>(
      sql`select * from app.portal_document_file_path(${shareId}::uuid, ${fileId}::uuid)`)).rows[0]);
    const seconds = 600;
    const url = await this.signer.signDownload('document-files', f.storage_path, seconds, f.file_name);
    if (!url) throw ApiError.notFound('file_not_found', 'File not found');
    return { url, expiresIn: seconds, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
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
