import { Injectable } from '@nestjs/common';
import { and, asc, eq, SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { decodeCursor, Page, toPage } from '../common/pagination';
import type { RequestContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { departments, sites } from '../database/schema';
import {
  CreateDepartmentBody,
  CreateSiteBody,
  Department,
  DepartmentListQuery,
  Site,
  SiteListQuery,
  UpdateDepartmentBody,
  UpdateSiteBody,
} from './structure.schemas';

const siteColumns = { id: sites.id, code: sites.code, name: sites.name, timezone: sites.timezone, currency: sites.currency, active: sites.active };
const departmentColumns = {
  id: departments.id,
  siteId: departments.siteId,
  code: departments.code,
  name: departments.name,
  active: departments.active,
};

/**
 * Sites and departments of the current organisation. Rows of other organisations are invisible
 * through RLS, so an id from another tenant behaves exactly like an id that does not exist (404).
 * Records are deactivated, never deleted.
 */
@Injectable()
export class StructureService {
  constructor(private readonly database: DatabaseService) {}

  listSites(ctx: RequestContext, q: z.infer<typeof SiteListQuery>): Promise<Page<Site>> {
    const cursor = decodeCursor(q.cursor);
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [eq(sites.organisationId, ctx.organisationId!)];
      if (!q.includeInactive) where.push(eq(sites.active, true));
      if (cursor) where.push(sql`(${sites.code}, ${sites.id}) > (${cursor.k}, ${cursor.id}::uuid)`);
      const rows = await db.select(siteColumns).from(sites).where(and(...where)).orderBy(asc(sites.code), asc(sites.id)).limit(q.limit + 1);
      return toPage(rows, q.limit, (r) => ({ k: r.code, id: r.id }));
    });
  }

  createSite(ctx: RequestContext, body: z.infer<typeof CreateSiteBody>): Promise<Site> {
    return this.database.asUser(ctx, async (db) => {
      const [row] = await db
        .insert(sites)
        .values({ organisationId: ctx.organisationId!, code: body.code, name: body.name, ...(body.timezone ? { timezone: body.timezone } : {}), currency: body.currency ?? sql`null` })
        .returning(siteColumns);
      return row;
    });
  }

  updateSite(ctx: RequestContext, id: string, body: z.infer<typeof UpdateSiteBody>): Promise<Site> {
    return this.database.asUser(ctx, async (db) => {
      const [row] = await db
        .update(sites)
        .set(body)
        .where(and(eq(sites.id, id), eq(sites.organisationId, ctx.organisationId!)))
        .returning(siteColumns);
      if (!row) throw ApiError.notFound('site_not_found', 'Site not found');
      return row;
    });
  }

  listDepartments(ctx: RequestContext, q: z.infer<typeof DepartmentListQuery>): Promise<Page<Department>> {
    const cursor = decodeCursor(q.cursor);
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [eq(departments.organisationId, ctx.organisationId!)];
      if (q.siteId) where.push(eq(departments.siteId, q.siteId));
      if (!q.includeInactive) where.push(eq(departments.active, true));
      if (cursor) where.push(sql`(${departments.code}, ${departments.id}) > (${cursor.k}, ${cursor.id}::uuid)`);
      const rows = await db
        .select(departmentColumns)
        .from(departments)
        .where(and(...where))
        .orderBy(asc(departments.code), asc(departments.id))
        .limit(q.limit + 1);
      return toPage(rows, q.limit, (r) => ({ k: r.code, id: r.id }));
    });
  }

  createDepartment(ctx: RequestContext, body: z.infer<typeof CreateDepartmentBody>): Promise<Department> {
    return this.database.asUser(ctx, async (db) => {
      // The site must be visible in this organisation (the composite FK enforces it too).
      const [site] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, body.siteId), eq(sites.organisationId, ctx.organisationId!)));
      if (!site) throw ApiError.badRequest('invalid_reference', 'Site not found in this organisation');
      const [row] = await db
        .insert(departments)
        .values({ organisationId: ctx.organisationId!, siteId: body.siteId, code: body.code, name: body.name })
        .returning(departmentColumns);
      return row;
    });
  }

  updateDepartment(ctx: RequestContext, id: string, body: z.infer<typeof UpdateDepartmentBody>): Promise<Department> {
    return this.database.asUser(ctx, async (db) => {
      const [row] = await db
        .update(departments)
        .set(body)
        .where(and(eq(departments.id, id), eq(departments.organisationId, ctx.organisationId!)))
        .returning(departmentColumns);
      if (!row) throw ApiError.notFound('department_not_found', 'Department not found');
      return row;
    });
  }
}
