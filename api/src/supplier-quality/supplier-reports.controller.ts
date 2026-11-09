import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { Report, ReportQuery } from './supplier-reports.schemas';
import { SupplierReportsService } from './supplier-reports.service';

/**
 * Supplier reports for export (SQ6d). Each answers with the rows plus what a reader needs later: the period, the definitions used, the scoring model, and when it was worked out.
 * Read-only: nothing is changed or stored.
 */
@ApiTags('supplier-quality')
@ApiBearerAuth()
@Controller('supplier-quality/reports')
export class SupplierReportsController {
  constructor(private readonly service: SupplierReportsService) {}

  @Get('performance')
  @OrganisationScoped('supplier_quality.read')
  @ApiOkResponse({ description: 'Every active supplier scored over the period (default: the last 90 days) under the current scoring model, with the definitions and the date it was generated; needs receiving.read as well', schema: openApiSchema(Report) })
  performance(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.performance(ctx, parse(ReportQuery, query));
  }

  @Get('audits')
  @OrganisationScoped('audits.read')
  @ApiOkResponse({ description: 'Audit records carried out on suppliers in the period (default: the last 90 days), one row per record and supplier', schema: openApiSchema(Report) })
  audits(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.audits(ctx, parse(ReportQuery, query));
  }
}
