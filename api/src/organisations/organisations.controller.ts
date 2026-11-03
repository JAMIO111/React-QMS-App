import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { organisations, organisationSettings } from '../database/schema';
import { OrganisationScoped } from '../tenancy/organisation.guard';

const OrganisationResponse = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(['active', 'suspended']),
  settings: z.object({ baseCurrency: z.string(), vatRate: z.number(), ncrReferencePrefix: z.string() }),
});

/** Phase 1.3 exposes the read used to exercise organisation scoping; editing arrives in 1.4. */
@ApiTags('organisations')
@ApiBearerAuth()
@Controller('organisations')
export class OrganisationsController {
  constructor(private readonly database: DatabaseService) {}

  @Get('current')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'The organisation named by X-Organisation-Id', schema: openApiSchema(OrganisationResponse) })
  current(@Ctx() ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const [row] = await db
        .select({ org: organisations, settings: organisationSettings })
        .from(organisations)
        .innerJoin(organisationSettings, eq(organisationSettings.organisationId, organisations.id))
        .where(eq(organisations.id, ctx.organisationId!));
      if (!row) throw ApiError.notFound('organisation_not_found', 'Organisation not found');
      return {
        id: row.org.id,
        name: row.org.name,
        slug: row.org.slug,
        status: row.org.status,
        settings: {
          baseCurrency: row.settings.baseCurrency,
          vatRate: Number(row.settings.vatRate),
          ncrReferencePrefix: row.settings.ncrReferencePrefix,
        },
      };
    });
  }
}
