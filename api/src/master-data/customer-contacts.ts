import { Body, Controller, Get, HttpCode, Injectable, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { DatabaseService, Db } from '../database/database.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';

/**
 * Customer contacts (docs/external-portal-plan.md X17): several per customer, one primary, deactivated and never deleted — the same shape as a supplier's.
 * Staff data under master_data.read / .manage; nothing here is shown to a customer in the portal.
 */
const ROLES = ['quality', 'purchasing', 'sales', 'technical', 'accounts', 'logistics', 'management', 'other'] as const;
const text = (max: number) => z.string().trim().min(1).max(max).nullish();
const fields = { name: z.string().trim().min(1).max(120), jobTitle: text(120), role: z.enum(ROLES), email: text(200), phone: text(40), isPrimary: z.boolean(), notes: text(1000) };
export const CreateCustomerContactBody = z.object({ ...fields, role: fields.role.default('other'), isPrimary: fields.isPrimary.default(false) }).strict();
export const UpdateCustomerContactBody = z
  .object({ ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])), active: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

type Row = Record<string, unknown>;
const COLUMN: Record<string, string> = { name: 'name', jobTitle: 'job_title', role: 'role', email: 'email', phone: 'phone', isPrimary: 'is_primary', notes: 'notes', active: 'active' };
const toContact = (r: Row) => ({
  id: r.id as string,
  customerId: r.customer_id as string,
  name: r.name as string,
  jobTitle: (r.job_title as string | null) ?? null,
  role: r.role as (typeof ROLES)[number],
  email: (r.email as string | null) ?? null,
  phone: (r.phone as string | null) ?? null,
  isPrimary: Boolean(r.is_primary),
  active: Boolean(r.active),
  notes: (r.notes as string | null) ?? null,
});

@Injectable()
export class CustomerContactsService {
  constructor(private readonly database: DatabaseService) {}

  private async list(db: Db, ctx: RequestContext, customerId: string) {
    const r = await db.execute<Row>(sql`select * from public.customer_contacts where customer_id = ${customerId}::uuid and organisation_id = ${ctx.organisationId}::uuid order by active desc, is_primary desc, lower(name)`);
    return { data: r.rows.map(toContact) };
  }

  private async assertCustomer(db: Db, ctx: RequestContext, id: string) {
    const r = await db.execute(sql`select 1 from public.customers where id = ${id}::uuid and organisation_id = ${ctx.organisationId}::uuid`);
    if (r.rows.length === 0) throw ApiError.notFound('customer_not_found', 'Customer not found');
  }

  forCustomer(ctx: RequestContext, customerId: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.assertCustomer(db, ctx, customerId);
      return this.list(db, ctx, customerId);
    });
  }

  create(ctx: RequestContext, customerId: string, b: z.infer<typeof CreateCustomerContactBody>) {
    return this.database.asUser(ctx, async (db) => {
      await this.assertCustomer(db, ctx, customerId);
      await db.execute(
        sql`insert into public.customer_contacts (organisation_id, customer_id, name, job_title, role, email, phone, is_primary, notes)
            values (${ctx.organisationId}::uuid, ${customerId}::uuid, ${b.name}, ${b.jobTitle ?? null}, ${b.role}, ${b.email ?? null}, ${b.phone ?? null}, ${b.isPrimary}, ${b.notes ?? null})`,
      );
      return this.list(db, ctx, customerId);
    });
  }

  update(ctx: RequestContext, id: string, b: z.infer<typeof UpdateCustomerContactBody>) {
    return this.database.asUser(ctx, async (db) => {
      const sets = Object.entries(b).map(([k, v]) => sql`${sql.raw(COLUMN[k])} = ${v ?? null}`);
      const r = await db.execute<{ customer_id: string }>(sql`update public.customer_contacts set ${sql.join(sets, sql`, `)} where id = ${id}::uuid and organisation_id = ${ctx.organisationId}::uuid returning customer_id`);
      if (r.rows.length === 0) throw ApiError.notFound('contact_not_found', 'Contact not found');
      return this.list(db, ctx, r.rows[0].customer_id);
    });
  }
}

@ApiTags('customers')
@ApiBearerAuth()
@Controller()
export class CustomerContactsController {
  constructor(private readonly service: CustomerContactsService) {}

  @Get('customers/:id/contacts')
  @OrganisationScoped('master_data.read')
  @ApiOkResponse({ description: 'A customer’s contacts, the primary first' })
  list(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.forCustomer(ctx, parse(Uuid, id));
  }

  @Post('customers/:id/contacts')
  @HttpCode(201)
  @OrganisationScoped('master_data.manage')
  @ApiBody({ schema: openApiSchema(CreateCustomerContactBody) })
  @ApiCreatedResponse({ description: 'Adds a contact (a new primary contact replaces the old one); answers with the customer’s contacts' })
  create(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.create(ctx, parse(Uuid, id), parse(CreateCustomerContactBody, body));
  }

  @Patch('customer-contacts/:id')
  @OrganisationScoped('master_data.manage')
  @ApiBody({ schema: openApiSchema(UpdateCustomerContactBody) })
  @ApiOkResponse({ description: 'Edits or deactivates a contact (never deleted); answers with the customer’s contacts' })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateCustomerContactBody, body));
  }
}
