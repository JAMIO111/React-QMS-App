import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { organisations, organisationSettings } from '../database/schema';
import type { CreateOrganisationBody, OrganisationResponse, UpdateOrganisationBody } from './organisations.schemas';

@Injectable()
export class OrganisationsService {
  constructor(private readonly database: DatabaseService) {}

  /** Starts an organisation with the caller as Owner (app.start_organisation: create, time zone, country, the billing gate and the wizard row, atomically). */
  create(ctx: RequestContext, body: CreateOrganisationBody, idempotencyKey?: string): Promise<OrganisationResponse> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute<{ id: string }>(
        sql`select app.start_organisation(${body.name}, ${body.site?.name ?? 'Main site'}, ${body.site?.code ?? 'MAIN'}, ${body.timeZone ?? null}, ${body.country ?? null}, ${idempotencyKey ?? null}) as id`,
      );
      return this.load(db, result.rows[0].id);
    });
  }

  get(ctx: RequestContext, organisationId: string): Promise<OrganisationResponse> {
    return this.database.asUser(ctx, (db) => this.load(db, organisationId));
  }

  update(ctx: RequestContext, organisationId: string, body: UpdateOrganisationBody): Promise<OrganisationResponse> {
    const logoPath = body.settings?.logoPath;
    if (logoPath && (!logoPath.startsWith(`${organisationId}/logo/`) || logoPath.includes('..') || logoPath.length === `${organisationId}/logo/`.length)) {
      throw ApiError.badRequest('invalid_path', `Upload the logo to ${organisationId}/logo/ in the org-logos bucket`);
    }
    return this.database.asUser(ctx, async (db) => {
      if (logoPath) {
        const stored = await db.execute(sql`select 1 from storage.objects where bucket_id = 'org-logos' and name = ${logoPath}`);
        if (!stored.rows.length) throw ApiError.badRequest('file_not_uploaded', 'Upload the logo before saving it');
      }
      if (body.name !== undefined || body.legalName !== undefined || body.country !== undefined) {
        const updated = await db
          .update(organisations)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.legalName !== undefined ? { legalName: body.legalName || null } : {}),
            ...(body.country !== undefined ? { country: body.country } : {}),
          })
          .where(eq(organisations.id, organisationId))
          .returning({ id: organisations.id });
        if (updated.length === 0) throw ApiError.forbidden();
      }
      if (body.settings) {
        const s = body.settings;
        const updated = await db
          .update(organisationSettings)
          .set({
            ...(s.baseCurrency !== undefined ? { baseCurrency: s.baseCurrency } : {}),
            ...(s.vatRate !== undefined ? { vatRate: String(s.vatRate) } : {}),
            ...(s.ncrReferencePrefix !== undefined ? { ncrReferencePrefix: s.ncrReferencePrefix } : {}),
            ...(s.themeColour !== undefined ? { themeColour: s.themeColour } : {}),
            ...(s.requireMfa !== undefined ? { requireMfa: s.requireMfa } : {}),
            ...(s.logoPath !== undefined ? { logoPath: s.logoPath } : {}),
          })
          .where(eq(organisationSettings.organisationId, organisationId))
          .returning({ id: organisationSettings.organisationId });
        if (updated.length === 0) throw ApiError.forbidden();
      }
      return this.load(db, organisationId);
    });
  }

  private async load(db: Db, organisationId: string): Promise<OrganisationResponse> {
    const [row] = await db
      .select({ org: organisations, settings: organisationSettings })
      .from(organisations)
      .innerJoin(organisationSettings, eq(organisationSettings.organisationId, organisations.id))
      .where(eq(organisations.id, organisationId));
    if (!row) throw ApiError.notFound('organisation_not_found', 'Organisation not found');
    return {
      id: row.org.id,
      name: row.org.name,
      slug: row.org.slug,
      status: row.org.status as OrganisationResponse['status'],
      legalName: row.org.legalName ?? null,
      country: row.org.country ?? null,
      settings: {
        baseCurrency: row.settings.baseCurrency,
        vatRate: Number(row.settings.vatRate),
        ncrReferencePrefix: row.settings.ncrReferencePrefix,
        themeColour: row.settings.themeColour as OrganisationResponse['settings']['themeColour'],
        requireMfa: row.settings.requireMfa,
        logoPath: row.settings.logoPath ?? null,
      },
    };
  }
}
