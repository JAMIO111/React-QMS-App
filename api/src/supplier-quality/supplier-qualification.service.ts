import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { expiryOf, todayIn } from './expiry';
import {
  CreateCertificationBody, CreateDocumentBody, ReasonBody, RenewCertificationBody, SupplierCertification, SupplierDocument, UpdateCertificationBody, UpdateDocumentBody, VerifyBody,
  Watchlist, WatchlistQuery,
} from './supplier-qualification.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown user' } : null);
const supplierNotFound = () => ApiError.notFound('supplier_not_found', 'Supplier not found');

const DOCUMENT_SELECT = sql`
  select d.*, d.document_date::text as document_date_t, d.expires_on::text as expires_on_t,
         ${sql.raw(personName('pv'))} as verified_by_name, ${sql.raw(personName('pr'))} as removed_by_name, ${sql.raw(personName('pc'))} as created_by_name
  from public.supplier_documents d
  left join public.profiles pv on pv.id = d.verified_by
  left join public.profiles pr on pr.id = d.removed_by
  left join public.profiles pc on pc.id = d.created_by`;

const CERT_SELECT = sql`
  select c.*, c.issued_on::text as issued_on_t, c.expires_on::text as expires_on_t, doc.title as doc_title, doc.file_name as doc_file_name, doc.storage_path as doc_path,
         ${sql.raw(personName('pv'))} as verified_by_name, ${sql.raw(personName('pw'))} as withdrawn_by_name, ${sql.raw(personName('pc'))} as created_by_name
  from public.supplier_certifications c
  left join public.supplier_documents doc on doc.id = c.document_id
  left join public.profiles pv on pv.id = c.verified_by
  left join public.profiles pw on pw.id = c.withdrawn_by
  left join public.profiles pc on pc.id = c.created_by`;

const toDocument = (r: Row, today: string): SupplierDocument => ({
  id: r.id as string,
  supplierId: r.supplier_id as string,
  docType: r.doc_type as SupplierDocument['docType'],
  title: r.title as string,
  revision: (r.revision as string) ?? null,
  documentDate: (r.document_date_t as string) ?? null,
  expiresOn: (r.expires_on_t as string) ?? null,
  notes: (r.notes as string) ?? null,
  storagePath: r.storage_path as string,
  fileName: r.file_name as string,
  contentType: (r.content_type as string) ?? null,
  sizeBytes: Number(r.size_bytes),
  status: r.status as SupplierDocument['status'],
  replacesId: (r.replaces_id as string) ?? null,
  expiry: r.status === 'current' ? expiryOf(r.expires_on_t as string | null, today) : { state: 'no_expiry', daysLeft: null },
  verification: r.verified_at ? { at: iso(r.verified_at)!, by: person(r.verified_by, r.verified_by_name), note: (r.verification_note as string) ?? null } : null,
  removal: r.removed_at ? { at: iso(r.removed_at)!, by: person(r.removed_by, r.removed_by_name), reason: r.removal_reason as string } : null,
  createdAt: iso(r.created_at)!,
  createdBy: person(r.created_by, r.created_by_name),
});

const toCertification = (r: Row, today: string): SupplierCertification => ({
  id: r.id as string,
  supplierId: r.supplier_id as string,
  certType: r.cert_type as SupplierCertification['certType'],
  title: (r.title as string) ?? null,
  certificateNumber: r.certificate_number as string,
  issuingBody: r.issuing_body as string,
  scope: (r.scope as string) ?? null,
  issuedOn: (r.issued_on_t as string) ?? null,
  expiresOn: (r.expires_on_t as string) ?? null,
  document: r.document_id ? { id: r.document_id as string, title: (r.doc_title as string) ?? 'Document', fileName: (r.doc_file_name as string) ?? '', storagePath: (r.doc_path as string) ?? '' } : null,
  notes: (r.notes as string) ?? null,
  status: r.status as SupplierCertification['status'],
  replacesId: (r.replaces_id as string) ?? null,
  expiry: r.status === 'current' ? expiryOf(r.expires_on_t as string | null, today) : { state: 'no_expiry', daysLeft: null },
  verification: r.verified_at ? { at: iso(r.verified_at)!, by: person(r.verified_by, r.verified_by_name), note: (r.verification_note as string) ?? null } : null,
  withdrawal: r.withdrawn_at ? { at: iso(r.withdrawn_at)!, by: person(r.withdrawn_by, r.withdrawn_by_name), reason: r.withdrawal_reason as string } : null,
  createdAt: iso(r.created_at)!,
  createdBy: person(r.created_by, r.created_by_name),
});

/** The camelCase keys the database functions read, from a validated body (undefined keys are left out so an edit changes only what was sent). */
const present = (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));

/**
 * Supplier qualification records (SQ2a): documents and certifications. Every write is a database function (permission, tenant, frozen-once-verified and
 * renewal rules); expiry is worked out here when read and never changes a supplier's approval status.
 */
@Injectable()
export class SupplierQualificationService {
  constructor(private readonly database: DatabaseService) {}

  private async assertSupplier(db: Db, ctx: RequestContext, id: string) {
    const res = await db.execute(sql`select 1 from public.suppliers where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (res.rows.length === 0) throw supplierNotFound();
  }

  // ---- documents -----------------------------------------------------------------------------------

  documents(ctx: RequestContext, supplierId: string): Promise<{ data: SupplierDocument[] }> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      const rows = await db.execute<Row>(sql`${DOCUMENT_SELECT} where d.supplier_id = ${supplierId}::uuid and d.organisation_id = ${orgOf(ctx)}::uuid
        order by (d.status = 'current') desc, d.created_at desc`);
      const today = todayIn(ctx.timeZone);
      return { data: rows.rows.map((r) => toDocument(r, today)) };
    });
  }

  private async loadDocument(db: Db, ctx: RequestContext, id: string): Promise<SupplierDocument> {
    const rows = await db.execute<Row>(sql`${DOCUMENT_SELECT} where d.id = ${id}::uuid and d.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!rows.rows.length) throw ApiError.notFound('supplier_document_not_found', 'Document not found');
    return toDocument(rows.rows[0], todayIn(ctx.timeZone));
  }

  createDocument(ctx: RequestContext, supplierId: string, b: CreateDocumentBody): Promise<SupplierDocument> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      const res = await db.execute<{ id: string }>(sql`
        select app.add_supplier_document(${supplierId}::uuid, ${b.docType}, ${b.title}, ${b.revision ?? null}, ${b.documentDate ?? null}::date, ${b.expiresOn ?? null}::date, ${b.notes ?? null},
          ${b.storagePath}, ${b.fileName}, ${b.contentType ?? null}, ${b.sizeBytes}::bigint, ${b.replacesId ?? null}::uuid) as id`);
      return this.loadDocument(db, ctx, res.rows[0].id);
    });
  }

  updateDocument(ctx: RequestContext, id: string, b: UpdateDocumentBody): Promise<SupplierDocument> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadDocument(db, ctx, id);
      await db.execute(sql`select app.update_supplier_document(${id}::uuid, ${JSON.stringify(present(b))}::jsonb)`);
      return this.loadDocument(db, ctx, id);
    });
  }

  verifyDocument(ctx: RequestContext, id: string, b: VerifyBody): Promise<SupplierDocument> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadDocument(db, ctx, id);
      await db.execute(sql`select app.verify_supplier_document(${id}::uuid, ${b.note ?? null})`);
      return this.loadDocument(db, ctx, id);
    });
  }

  removeDocument(ctx: RequestContext, id: string, b: ReasonBody): Promise<SupplierDocument> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadDocument(db, ctx, id);
      await db.execute(sql`select app.remove_supplier_document(${id}::uuid, ${b.reason})`);
      return this.loadDocument(db, ctx, id);
    });
  }

  // ---- certifications ------------------------------------------------------------------------------

  certifications(ctx: RequestContext, supplierId: string): Promise<{ data: SupplierCertification[] }> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      const rows = await db.execute<Row>(sql`${CERT_SELECT} where c.supplier_id = ${supplierId}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid
        order by (c.status = 'current') desc, c.expires_on nulls last, c.created_at desc`);
      const today = todayIn(ctx.timeZone);
      return { data: rows.rows.map((r) => toCertification(r, today)) };
    });
  }

  private async loadCertification(db: Db, ctx: RequestContext, id: string): Promise<SupplierCertification> {
    const rows = await db.execute<Row>(sql`${CERT_SELECT} where c.id = ${id}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!rows.rows.length) throw ApiError.notFound('supplier_certification_not_found', 'Certification not found');
    return toCertification(rows.rows[0], todayIn(ctx.timeZone));
  }

  createCertification(ctx: RequestContext, supplierId: string, b: CreateCertificationBody): Promise<SupplierCertification> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      const res = await db.execute<{ id: string }>(sql`select app.add_supplier_certification(${supplierId}::uuid, ${JSON.stringify(present(b))}::jsonb) as id`);
      return this.loadCertification(db, ctx, res.rows[0].id);
    });
  }

  updateCertification(ctx: RequestContext, id: string, b: UpdateCertificationBody): Promise<SupplierCertification> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadCertification(db, ctx, id);
      await db.execute(sql`select app.update_supplier_certification(${id}::uuid, ${JSON.stringify(present(b))}::jsonb)`);
      return this.loadCertification(db, ctx, id);
    });
  }

  renewCertification(ctx: RequestContext, id: string, b: RenewCertificationBody): Promise<SupplierCertification> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadCertification(db, ctx, id);
      const res = await db.execute<{ id: string }>(sql`select app.renew_supplier_certification(${id}::uuid, ${JSON.stringify(present(b))}::jsonb) as id`);
      return this.loadCertification(db, ctx, res.rows[0].id);
    });
  }

  verifyCertification(ctx: RequestContext, id: string, b: VerifyBody): Promise<SupplierCertification> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadCertification(db, ctx, id);
      await db.execute(sql`select app.verify_supplier_certification(${id}::uuid, ${b.note ?? null})`);
      return this.loadCertification(db, ctx, id);
    });
  }

  withdrawCertification(ctx: RequestContext, id: string, b: ReasonBody): Promise<SupplierCertification> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadCertification(db, ctx, id);
      await db.execute(sql`select app.withdraw_supplier_certification(${id}::uuid, ${b.reason})`);
      return this.loadCertification(db, ctx, id);
    });
  }

  // ---- watchlist -----------------------------------------------------------------------------------

  /**
   * Current certifications and documents that have expired or expire within `days`, across the organisation's suppliers, soonest first. A superseded, withdrawn
   * or removed record is no longer in force and never appears. Nothing here changes a supplier's status.
   */
  watchlist(ctx: RequestContext, q: WatchlistQuery): Promise<z.infer<typeof Watchlist>> {
    return this.database.asUser(ctx, async (db) => {
      const today = todayIn(ctx.timeZone);
      const wantCerts = q.kind !== 'document';
      const wantDocs = q.kind !== 'certification';
      const certs = wantCerts
        ? await db.execute<Row>(sql`
            select c.id, c.cert_type, c.title, c.certificate_number, c.issuing_body, c.expires_on::text as expires_on_t, (c.verified_at is not null) as verified, s.id as supplier_id, s.code, s.name
            from public.supplier_certifications c join public.suppliers s on s.id = c.supplier_id
            where c.organisation_id = ${orgOf(ctx)}::uuid and c.status = 'current' and c.expires_on is not null and s.active
              and c.expires_on <= (${today}::date + ${q.days}::int)`)
        : { rows: [] as Row[] };
      const docs = wantDocs
        ? await db.execute<Row>(sql`
            select d.id, d.doc_type, d.title, d.revision, d.expires_on::text as expires_on_t, (d.verified_at is not null) as verified, s.id as supplier_id, s.code, s.name
            from public.supplier_documents d join public.suppliers s on s.id = d.supplier_id
            where d.organisation_id = ${orgOf(ctx)}::uuid and d.status = 'current' and d.expires_on is not null and s.active
              and d.expires_on <= (${today}::date + ${q.days}::int)`)
        : { rows: [] as Row[] };
      const items = [
        ...certs.rows.map((r) => ({ kind: 'certification' as const, r, title: (r.title as string) ?? String(r.cert_type).replace(/_/g, ' ').toUpperCase(), detail: `${r.certificate_number as string} · ${r.issuing_body as string}` })),
        ...docs.rows.map((r) => ({ kind: 'document' as const, r, title: r.title as string, detail: (r.revision as string) ? `Revision ${r.revision as string}` : null })),
      ]
        .map(({ kind, r, title, detail }) => {
          const e = expiryOf(r.expires_on_t as string, today, q.days);
          return {
            kind,
            id: r.id as string,
            supplier: { id: r.supplier_id as string, code: r.code as string, name: r.name as string },
            title,
            detail,
            expiresOn: r.expires_on_t as string,
            state: e.state === 'expired' ? ('expired' as const) : ('expiring' as const),
            daysLeft: e.daysLeft!,
            verified: !!r.verified,
          };
        })
        .sort((a, b) => a.daysLeft - b.daysLeft || a.supplier.name.localeCompare(b.supplier.name));
      return { data: items, counts: { expired: items.filter((i) => i.state === 'expired').length, expiring: items.filter((i) => i.state === 'expiring').length }, days: q.days };
    });
  }
}
