import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { Certificate, CertificateList, CertificateListQuery, RecordCertificateBody, ReviewCertificateBody, UpdateCertificateBody, WithdrawCertificateBody } from './material-certificates.schemas';
import { z } from 'zod';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown user' } : null);

const toCertificate = (r: Row): Certificate => ({
  id: r.id as string,
  supplier: { id: r.supplier_id as string, code: r.supplier_code as string, name: r.supplier_name as string },
  certificateNumber: r.certificate_number as string,
  kind: r.kind as Certificate['kind'],
  part: r.part_id ? { id: r.part_id as string, partNumber: r.part_number as string, name: r.part_name as string } : null,
  material: (r.material as string) ?? null,
  specification: (r.specification as string) ?? null,
  heatNumber: (r.heat_number as string) ?? null,
  receiptLine: r.receipt_line_id ? { id: r.receipt_line_id as string, lineNumber: Number(r.line_number), receiptId: r.receipt_id as string, receiptReference: r.receipt_reference as string } : null,
  lot: r.lot_id ? { id: r.lot_id as string, lotNumber: r.lot_number as string } : null,
  issuedOn: r.issued_on ? String(r.issued_on).slice(0, 10) : null,
  document: r.document_id ? { id: r.document_id as string, title: r.document_title as string, fileName: r.document_file as string, storagePath: r.document_path as string } : null,
  notes: (r.notes as string) ?? null,
  status: r.status as Certificate['status'],
  reviewedBy: person(r.reviewed_by, r.reviewed_by_name),
  reviewedAt: iso(r.reviewed_at),
  reviewNote: (r.review_note as string) ?? null,
  withdrawnAt: iso(r.withdrawn_at),
  withdrawalReason: (r.withdrawal_reason as string) ?? null,
  createdBy: person(r.created_by, r.created_by_name),
  createdAt: iso(r.created_at)!,
});

const FROM = sql`
  from public.supplier_material_certificates c join public.suppliers s on s.id = c.supplier_id left join public.parts p on p.id = c.part_id
  left join public.goods_receipt_lines x on x.id = c.receipt_line_id left join public.goods_receipts g on g.id = x.goods_receipt_id left join public.lots l on l.id = c.lot_id
  left join public.supplier_documents d on d.id = c.document_id left join public.profiles pc on pc.id = c.created_by left join public.profiles pr on pr.id = c.reviewed_by`;
const COLUMNS = sql`c.*, s.code as supplier_code, s.name as supplier_name, p.part_number, p.name as part_name, x.line_number, g.id as receipt_id, g.reference as receipt_reference,
  l.lot_number, d.title as document_title, d.file_name as document_file, d.storage_path as document_path, ${sql.raw(personName('pc'))} as created_by_name, ${sql.raw(personName('pr'))} as reviewed_by_name`;

/** Material certificates: the register, recording, editing until reviewed, review (accept / reject) and withdrawal. Every write is a database function. */
@Injectable()
export class MaterialCertificatesService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, q: CertificateListQuery): Promise<z.infer<typeof CertificateList>> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`c.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.status === 'live') where.push(sql`c.status in ('received', 'accepted')`);
      else if (q.status === 'review') where.push(sql`c.status = 'received'`);
      else if (q.status !== 'all') where.push(sql`c.status = any(string_to_array(${q.status}, ','))`);
      if (q.supplierId) where.push(sql`c.supplier_id = ${q.supplierId}::uuid`);
      if (q.lotId) where.push(sql`c.lot_id = ${q.lotId}::uuid`);
      if (q.receiptLineId) where.push(sql`c.receipt_line_id = ${q.receiptLineId}::uuid`);
      if (q.partId) where.push(sql`c.part_id = ${q.partId}::uuid`);
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        where.push(sql`(c.certificate_number ilike ${like} or c.heat_number ilike ${like} or c.material ilike ${like} or p.part_number ilike ${like} or l.lot_number ilike ${like} or s.name ilike ${like} or s.code ilike ${like})`);
      }
      const cond = sql.join(where, sql` and `);
      const [rows, total, review] = await Promise.all([
        db.execute<Row>(sql`select ${COLUMNS} ${FROM} where ${cond} order by (c.status = 'received') desc, c.created_at desc limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`),
        db.execute<{ n: number }>(sql`select count(*)::int as n ${FROM} where ${cond}`),
        db.execute<{ n: number }>(sql`select count(*)::int as n from public.supplier_material_certificates where organisation_id = ${orgOf(ctx)}::uuid and status = 'received'`),
      ]);
      return { data: rows.rows.map(toCertificate), page: q.page, pageSize: q.pageSize, total: total.rows[0].n, reviewCount: review.rows[0].n };
    });
  }

  private async one(db: Db, ctx: RequestContext, id: string): Promise<Certificate> {
    const rows = await db.execute<Row>(sql`select ${COLUMNS} ${FROM} where c.id = ${id}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!rows.rows[0]) throw ApiError.notFound('material_certificate_not_found', 'Material certificate not found');
    return toCertificate(rows.rows[0]);
  }

  get(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.one(db, ctx, id));
  }

  record(ctx: RequestContext, b: RecordCertificateBody): Promise<Certificate> {
    return this.database.asUser(ctx, async (db) => {
      const { supplierId, ...data } = b;
      const res = await db.execute<{ id: string }>(sql`select app.record_material_certificate(${supplierId}::uuid, ${JSON.stringify(data)}::jsonb) as id`);
      return this.one(db, ctx, res.rows[0].id);
    });
  }

  update(ctx: RequestContext, id: string, b: UpdateCertificateBody): Promise<Certificate> {
    return this.database.asUser(ctx, async (db) => {
      await this.one(db, ctx, id);
      await db.execute(sql`select app.update_material_certificate(${id}::uuid, ${JSON.stringify(b)}::jsonb)`);
      return this.one(db, ctx, id);
    });
  }

  review(ctx: RequestContext, id: string, b: ReviewCertificateBody): Promise<Certificate> {
    return this.database.asUser(ctx, async (db) => {
      await this.one(db, ctx, id);
      await db.execute(sql`select app.review_material_certificate(${id}::uuid, ${b.accept}, ${b.note ?? null})`);
      return this.one(db, ctx, id);
    });
  }

  withdraw(ctx: RequestContext, id: string, b: WithdrawCertificateBody): Promise<Certificate> {
    return this.database.asUser(ctx, async (db) => {
      await this.one(db, ctx, id);
      await db.execute(sql`select app.withdraw_material_certificate(${id}::uuid, ${b.reason})`);
      return this.one(db, ctx, id);
    });
  }
}
