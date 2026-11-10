import { attachCustomValues, customFilterSql, customValuesOf, writeCustomValues } from '../custom-fields/custom-values';
import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { assignments, insertParts, iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import {
  ChangeStatusBody, Classification, ClassificationsQuery, CreateClassificationBody, CreateContactBody, CreateProductBody, CreateSupplierBody, SetClassificationsBody,
  StatusHistoryItem, SupplierContact, SupplierDetail, SupplierListQuery, SupplierPage, SupplierProduct, SupplierRow, UpdateClassificationBody, UpdateContactBody, UpdateProductBody, UpdateSupplierBody,
} from './supplier-quality.schemas';
import { z } from 'zod';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const notFound = () => ApiError.notFound('supplier_not_found', 'Supplier not found');

/** Register sort fields as SQL. `o.n` is the open non-conformance count (lateral join). */
const SORT_SQL: Record<SupplierListQuery['sort'], string> = {
  code: 'upper(s.code)',
  name: 'lower(s.name)',
  supplierType: 's.supplier_type',
  approvalStatus: `array_position(array['pending_approval','approved','conditional','suspended','disqualified','archived'], s.approval_status)`,
  riskRating: `array_position(array['low','medium','high','critical'], s.risk_rating)`,
  country: 's.country',
  openNcs: 'coalesce(o.n, 0)',
  createdAt: 's.created_at',
};

/** API field → column, for creating and editing a supplier. */
const SUPPLIER_COLUMNS: Record<string, string> = {
  code: 'code', name: 'name', displayName: 'display_name', companyNumber: 'company_number', vatNumber: 'vat_number', notes: 'notes', supplierType: 'supplier_type',
  country: 'country', addressLine1: 'address_line1', addressLine2: 'address_line2', city: 'city', region: 'region', postcode: 'postcode', website: 'website', email: 'email',
  phone: 'phone', purchasingReference: 'purchasing_reference', active: 'active',
};
const CONTACT_COLUMNS: Record<string, string> = { name: 'name', jobTitle: 'job_title', role: 'role', email: 'email', phone: 'phone', isPrimary: 'is_primary', active: 'active', notes: 'notes' };
const CLASSIFICATION_COLUMNS: Record<string, string> = { label: 'label', description: 'description', sequence: 'sequence', active: 'active' };

const LIST_COLUMNS = sql`
  s.id, s.code, s.name, s.display_name, s.supplier_type, s.country, s.city, s.approval_status, s.approval_status_changed_at, s.active, s.risk_rating, s.created_at,
  coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label) order by c.sequence, c.label)
              from public.supplier_classification_links l join public.supplier_classifications c on c.id = l.classification_id where l.supplier_id = s.id), '[]'::jsonb) as classifications,
  (select jsonb_build_object('name', k.name, 'email', k.email, 'phone', k.phone) from public.supplier_contacts k where k.supplier_id = s.id and k.is_primary limit 1) as primary_contact,
  coalesce(o.n, 0) as open_ncs`;
const OPEN_NCS = sql`
  left join lateral (select count(*)::int as n from public.nonconformances n
                      where n.supplier_id = s.id and n.deleted_at is null and n.stage not in ('closed', 'cancelled')) o on true`;

const toRow = (r: Row): SupplierRow => ({
  id: r.id as string,
  code: r.code as string,
  name: r.name as string,
  displayName: (r.display_name as string) ?? null,
  supplierType: (r.supplier_type as SupplierRow['supplierType']) ?? null,
  country: (r.country as string) ?? null,
  city: (r.city as string) ?? null,
  approvalStatus: r.approval_status as SupplierRow['approvalStatus'],
  approvalStatusChangedAt: iso(r.approval_status_changed_at),
  active: !!r.active,
  riskRating: (r.risk_rating as SupplierRow['riskRating']) ?? null,
  classifications: (r.classifications as SupplierRow['classifications']) ?? [],
  primaryContact: (r.primary_contact as SupplierRow['primaryContact']) ?? null,
  openNcCount: Number(r.open_ncs ?? 0),
  createdAt: iso(r.created_at)!,
});

const toContact = (r: Row): SupplierContact => ({
  id: r.id as string,
  name: r.name as string,
  jobTitle: (r.job_title as string) ?? null,
  role: r.role as SupplierContact['role'],
  email: (r.email as string) ?? null,
  phone: (r.phone as string) ?? null,
  isPrimary: !!r.is_primary,
  active: !!r.active,
  notes: (r.notes as string) ?? null,
});

const toProduct = (r: Row): SupplierProduct => ({
  id: r.id as string,
  kind: r.kind as SupplierProduct['kind'],
  part: r.part_id ? { id: r.part_id as string, partNumber: r.part_number as string, name: r.part_name as string } : null,
  description: (r.description as string) ?? null,
  supplierPartNumber: (r.supplier_part_number as string) ?? null,
  notes: (r.notes as string) ?? null,
  active: !!r.active,
});

/**
 * Supplier quality, slice SQ1: the supplier register and profile on the existing suppliers table (docs/supplier-quality-plan.md). Everything runs as the caller (row-level security
 * and the database functions decide); the approval status moves only through app.change_supplier_status, classifications are replaced as a whole by a function.
 */
@Injectable()
export class SupplierQualityService {
  constructor(private readonly database: DatabaseService) {}

  // ---- register ------------------------------------------------------------------------------------

  list(ctx: RequestContext, q: SupplierListQuery, custom: Record<string, string> = {}): Promise<z.infer<typeof SupplierPage>> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`s.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.active === 'active') where.push(sql`s.active`);
      if (q.active === 'inactive') where.push(sql`not s.active`);
      if (q.status) where.push(sql`s.approval_status = any(string_to_array(${q.status}, ','))`);
      if (q.type) where.push(sql`s.supplier_type = any(string_to_array(${q.type}, ','))`);
      if (q.risk) where.push(sql`s.risk_rating = any(string_to_array(${q.risk}, ','))`);
      if (q.classificationId)
        where.push(sql`exists (select 1 from public.supplier_classification_links l where l.supplier_id = s.id and l.classification_id = any(string_to_array(${q.classificationId}, ',')::uuid[]))`);
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(s.code ilike ${like} or s.name ilike ${like} or s.display_name ilike ${like} or s.company_number ilike ${like} or s.vat_number ilike ${like}
          or s.purchasing_reference ilike ${like} or s.city ilike ${like} or s.country ilike ${like} or s.website ilike ${like} or s.email ilike ${like} or s.phone ilike ${like}
          or exists (select 1 from public.supplier_contacts k where k.supplier_id = s.id and (k.name ilike ${like} or k.email ilike ${like}))
          or exists (select 1 from public.supplier_classification_links l join public.supplier_classifications c on c.id = l.classification_id where l.supplier_id = s.id and c.label ilike ${like}))`);
      }
      const cf = await customFilterSql(db, orgOf(ctx), 'supplier', sql`s.id`, custom);
      if (cf) where.push(cf);
      const clause = sql.join(where, sql` and `);
      const order = sql.raw(`${SORT_SQL[q.sort]} ${q.order} nulls last, upper(s.code) asc`);
      const rows = await db.execute<Row>(sql`select ${LIST_COLUMNS} from public.suppliers s ${OPEN_NCS} where ${clause} order by ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      const count = await db.execute<{ n: number }>(sql`select count(*)::int as n from public.suppliers s where ${clause}`);
      return { data: await attachCustomValues(db, 'supplier', rows.rows.map(toRow)), page: q.page, pageSize: q.pageSize, total: Number(count.rows[0].n) };
    });
  }

  // ---- profile -------------------------------------------------------------------------------------

  get(ctx: RequestContext, id: string): Promise<SupplierDetail> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  private async load(db: Db, ctx: RequestContext, id: string): Promise<SupplierDetail> {
    const res = await db.execute<Row>(sql`
      select ${LIST_COLUMNS}, s.company_number, s.vat_number, s.notes, s.address_line1, s.address_line2, s.region, s.postcode, s.website, s.email, s.phone, s.purchasing_reference,
             s.approval_status_changed_by, ${sql.raw(personName('pc'))} as changed_by_name,
             (select h.conditions from public.supplier_status_history h where h.supplier_id = s.id and h.to_status = 'conditional' and s.approval_status = 'conditional' order by h.changed_at desc limit 1) as conditions,
             (select h.review_on::text from public.supplier_status_history h where h.supplier_id = s.id and h.to_status = 'conditional' and s.approval_status = 'conditional' order by h.changed_at desc limit 1) as review_on,
             (select count(*)::int from public.nonconformances n where n.supplier_id = s.id and n.deleted_at is null) as total_ncs,
             (select count(*)::int from public.lots l where l.supplier_id = s.id and l.origin = 'received') as received_lots,
             (select max(l.received_on)::text from public.lots l where l.supplier_id = s.id and l.origin = 'received') as last_received_on
      from public.suppliers s ${OPEN_NCS}
      left join public.profiles pc on pc.id = s.approval_status_changed_by
      where s.id = ${id}::uuid and s.organisation_id = ${orgOf(ctx)}::uuid`);
    const r = res.rows[0];
    if (!r) throw notFound();
    const contacts = await db.execute<Row>(sql`select * from public.supplier_contacts where supplier_id = ${id}::uuid order by active desc, is_primary desc, lower(name)`);
    const products = await db.execute<Row>(sql`
      select p.*, pt.part_number, pt.name as part_name from public.supplier_product_links p left join public.parts pt on pt.id = p.part_id
      where p.supplier_id = ${id}::uuid order by p.active desc, p.kind, coalesce(pt.part_number, p.description)`);
    const { primaryContact: _primary, ...base } = toRow(r);
    return {
      ...base,
      customValues: await customValuesOf(db, 'supplier', id),
      companyNumber: (r.company_number as string) ?? null,
      vatNumber: (r.vat_number as string) ?? null,
      notes: (r.notes as string) ?? null,
      addressLine1: (r.address_line1 as string) ?? null,
      addressLine2: (r.address_line2 as string) ?? null,
      region: (r.region as string) ?? null,
      postcode: (r.postcode as string) ?? null,
      website: (r.website as string) ?? null,
      email: (r.email as string) ?? null,
      phone: (r.phone as string) ?? null,
      purchasingReference: (r.purchasing_reference as string) ?? null,
      approvalStatusChangedBy: r.approval_status_changed_by ? { id: r.approval_status_changed_by as string, name: (r.changed_by_name as string) ?? 'Unknown user' } : null,
      conditions: (r.conditions as string) ?? null,
      reviewOn: (r.review_on as string) ?? null,
      contacts: contacts.rows.map(toContact),
      products: products.rows.map(toProduct),
      counts: { openNcs: Number(r.open_ncs), totalNcs: Number(r.total_ncs), receivedLots: Number(r.received_lots), lastReceivedOn: (r.last_received_on as string) ?? null },
    };
  }

  history(ctx: RequestContext, id: string): Promise<{ data: StatusHistoryItem[] }> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, id);
      const res = await db.execute<Row>(sql`
        select h.*, h.review_on::text as review_on_text, ${sql.raw(personName('p'))} as by_name
        from public.supplier_status_history h left join public.profiles p on p.id = h.changed_by
        where h.supplier_id = ${id}::uuid order by h.changed_at desc, h.created_at desc`);
      return {
        data: res.rows.map((r) => ({
          id: r.id as string,
          fromStatus: (r.from_status as StatusHistoryItem['fromStatus']) ?? null,
          toStatus: r.to_status as StatusHistoryItem['toStatus'],
          reason: (r.reason as string) ?? null,
          conditions: (r.conditions as string) ?? null,
          reviewOn: (r.review_on_text as string) ?? null,
          changedAt: iso(r.changed_at)!,
          changedBy: r.changed_by ? { id: r.changed_by as string, name: (r.by_name as string) ?? 'Unknown user' } : null,
        })),
      };
    });
  }

  private async assertSupplier(db: Db, ctx: RequestContext, id: string) {
    const res = await db.execute(sql`select 1 from public.suppliers where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (res.rows.length === 0) throw notFound();
  }

  // ---- create / edit -------------------------------------------------------------------------------

  create(ctx: RequestContext, body: CreateSupplierBody): Promise<SupplierDetail> {
    return this.database.asUser(ctx, async (db) => {
      const { classificationIds, customValues, ...fields } = body;
      const parts = insertParts(fields, SUPPLIER_COLUMNS, { organisation_id: orgOf(ctx) });
      const res = await db.execute<{ id: string }>(sql`insert into public.suppliers (${parts.columns}) values (${parts.values}) returning id`);
      const id = res.rows[0].id;
      if (classificationIds?.length) await db.execute(sql`select app.set_supplier_classifications(${id}::uuid, string_to_array(${classificationIds.join(',')}, ',')::uuid[])`);
      await writeCustomValues(db, 'supplier', id, customValues);
      return this.load(db, ctx, id);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateSupplierBody): Promise<SupplierDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, id);
      const sets = assignments(body, SUPPLIER_COLUMNS);
      const updated = await db.execute(sql`update public.suppliers set ${sql.join(sets, sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (updated.rows.length === 0) throw ApiError.forbidden('You are not allowed to edit this supplier');
      return this.load(db, ctx, id);
    });
  }

  changeStatus(ctx: RequestContext, id: string, body: ChangeStatusBody): Promise<SupplierDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, id);
      await db.execute(sql`select app.change_supplier_status(${id}::uuid, ${body.status}, ${body.reason}, ${body.conditions ?? null}, ${body.reviewOn ?? null}::date)`);
      return this.load(db, ctx, id);
    });
  }

  setClassifications(ctx: RequestContext, id: string, body: SetClassificationsBody): Promise<SupplierDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, id);
      await db.execute(sql`select app.set_supplier_classifications(${id}::uuid, string_to_array(${body.classificationIds.join(',')}, ',')::uuid[])`);
      return this.load(db, ctx, id);
    });
  }

  // ---- classifications -----------------------------------------------------------------------------

  async classifications(ctx: RequestContext, q: z.infer<typeof ClassificationsQuery>): Promise<{ data: Classification[] }> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`
        select c.*, (select count(*)::int from public.supplier_classification_links l where l.classification_id = c.id) as supplier_count
        from public.supplier_classifications c
        where c.organisation_id = ${orgOf(ctx)}::uuid ${q.all === 'true' ? sql`` : sql`and c.active`}
        order by c.sequence, lower(c.label)`);
      return { data: res.rows.map(toClassification) };
    });
  }

  createClassification(ctx: RequestContext, body: CreateClassificationBody): Promise<Classification> {
    return this.database.asUser(ctx, async (db) => {
      // The key is made from the label and kept: renaming later never changes it.
      const base = body.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36) || 'classification';
      let key = /^[a-z]/.test(base) ? base : `c_${base}`;
      for (let i = 2; ; i++) {
        const taken = await db.execute(sql`select 1 from public.supplier_classifications where organisation_id = ${orgOf(ctx)}::uuid and key = ${key}`);
        if (taken.rows.length === 0) break;
        key = `${base.slice(0, 34)}_${i}`;
      }
      const res = await db.execute<Row>(sql`
        insert into public.supplier_classifications (organisation_id, key, label, description, sequence)
        values (${orgOf(ctx)}::uuid, ${key}, ${body.label}, ${body.description ?? null},
                ${body.sequence ?? sql`(select coalesce(max(sequence), 0) + 1 from public.supplier_classifications where organisation_id = ${orgOf(ctx)}::uuid)`})
        returning *, 0 as supplier_count`);
      return toClassification(res.rows[0]);
    });
  }

  updateClassification(ctx: RequestContext, id: string, body: UpdateClassificationBody): Promise<Classification> {
    return this.database.asUser(ctx, async (db) => {
      const sets = assignments(body, CLASSIFICATION_COLUMNS);
      const res = await db.execute<Row>(sql`
        update public.supplier_classifications set ${sql.join(sets, sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid
        returning *, (select count(*)::int from public.supplier_classification_links l where l.classification_id = public.supplier_classifications.id) as supplier_count`);
      if (res.rows.length === 0) throw ApiError.notFound('classification_not_found', 'Classification not found');
      return toClassification(res.rows[0]);
    });
  }

  // ---- contacts ------------------------------------------------------------------------------------

  createContact(ctx: RequestContext, supplierId: string, body: CreateContactBody): Promise<SupplierDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      const parts = insertParts(body, CONTACT_COLUMNS, { organisation_id: orgOf(ctx), supplier_id: supplierId });
      await db.execute(sql`insert into public.supplier_contacts (${parts.columns}) values (${parts.values})`);
      return this.load(db, ctx, supplierId);
    });
  }

  updateContact(ctx: RequestContext, id: string, body: UpdateContactBody): Promise<SupplierDetail> {
    return this.database.asUser(ctx, async (db) => {
      const sets = assignments(body, CONTACT_COLUMNS);
      const res = await db.execute<{ supplier_id: string }>(sql`update public.supplier_contacts set ${sql.join(sets, sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning supplier_id`);
      if (res.rows.length === 0) throw ApiError.notFound('contact_not_found', 'Contact not found');
      return this.load(db, ctx, res.rows[0].supplier_id);
    });
  }

  // ---- products and services -----------------------------------------------------------------------

  createProduct(ctx: RequestContext, supplierId: string, body: CreateProductBody): Promise<SupplierDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      const parts = insertParts(
        { kind: body.kind, partId: body.partId ?? null, description: body.description, supplierPartNumber: body.supplierPartNumber, notes: body.notes },
        { kind: 'kind', partId: 'part_id', description: 'description', supplierPartNumber: 'supplier_part_number', notes: 'notes' },
        { organisation_id: orgOf(ctx), supplier_id: supplierId },
      );
      await db.execute(sql`insert into public.supplier_product_links (${parts.columns}) values (${parts.values})`);
      return this.load(db, ctx, supplierId);
    });
  }

  updateProduct(ctx: RequestContext, id: string, body: UpdateProductBody): Promise<SupplierDetail> {
    return this.database.asUser(ctx, async (db) => {
      const sets = assignments(body, { supplierPartNumber: 'supplier_part_number', notes: 'notes', active: 'active' });
      const res = await db.execute<{ supplier_id: string }>(sql`update public.supplier_product_links set ${sql.join(sets, sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning supplier_id`);
      if (res.rows.length === 0) throw ApiError.notFound('product_not_found', 'Product link not found');
      return this.load(db, ctx, res.rows[0].supplier_id);
    });
  }
}

const toClassification = (r: Row): Classification => ({
  id: r.id as string,
  key: r.key as string,
  label: r.label as string,
  description: (r.description as string) ?? null,
  sequence: Number(r.sequence),
  active: !!r.active,
  suppliers: Number(r.supplier_count ?? 0),
});
