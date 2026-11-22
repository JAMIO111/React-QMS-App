import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { ImportLockList, ImportLocksQuery } from './import-locks.schemas';
import { ImportLocksService } from './import-locks.service';

/**
 * Fields an import owns while its schedule is on. Any member may ask (forms disable those inputs); the database answers only for people who can read
 * that kind of record and only for records an import manages. Changing such a field is refused by the database: 409 field_managed_by_import.
 */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('import-locks')
export class ImportLocksController {
  constructor(private readonly service: ImportLocksService) {}

  @Get()
  @OrganisationScoped()
  @ApiOkResponse({ description: 'The locked fields of one record, each with the connection that manages it (empty when nothing is locked)', schema: openApiSchema(ImportLockList) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(ImportLocksQuery, query));
  }
}
