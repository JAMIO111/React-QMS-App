import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { pageSchema } from '../common/pagination';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AddPartCustomerBody,
  CreatePartBody,
  CreatePartyBody,
  CreateRevisionBody,
  Party,
  PartDetail,
  PartListQuery,
  PartRevision,
  PartSummary,
  PartyListQuery,
  UpdatePartBody,
  UpdatePartCustomerBody,
  UpdatePartyBody,
  UpdateRevisionBody,
  Unit,
} from './master-data.schemas';
import { MasterDataService, PartyKind } from './master-data.service';

const READ = 'master_data.read';
const MANAGE = 'master_data.manage';

const listQueries = (extra: MethodDecorator[] = []): MethodDecorator => (target, key, desc) => {
  [
    ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }),
    ApiQuery({ name: 'cursor', required: false, schema: { type: 'string' } }),
    ApiQuery({ name: 'q', required: false, schema: { type: 'string' }, description: 'Search code / number / name' }),
    ApiQuery({ name: 'includeInactive', required: false, schema: { type: 'boolean', default: false } }),
    ...extra,
  ].forEach((d) => d(target, key, desc));
};

@ApiTags('units')
@ApiBearerAuth()
@Controller('units')
export class UnitsController {
  constructor(private readonly service: MasterDataService) {}

  /** Global catalogue of measurement units (not organisation-specific). */
  @Get()
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Unit) })) })
  async list(@Ctx() ctx: RequestContext) {
    return { data: await this.service.listUnits(ctx) };
  }
}

/** Customers and suppliers share one shape and one set of rules. */
const partyController = (kind: PartyKind, path: string) => {
  @ApiTags(path)
  @ApiBearerAuth()
  @Controller(path)
  class PartyController {
    constructor(readonly service: MasterDataService) {}

    @Get()
    @OrganisationScoped(READ)
    @listQueries()
    @ApiOkResponse({ schema: openApiSchema(pageSchema(Party)) })
    list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
      return this.service.listParties(ctx, kind, parse(PartyListQuery, query));
    }

    @Post()
    @HttpCode(201)
    @OrganisationScoped(MANAGE)
    @ApiBody({ schema: openApiSchema(CreatePartyBody) })
    @ApiCreatedResponse({ schema: openApiSchema(Party) })
    create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
      return this.service.createParty(ctx, kind, parse(CreatePartyBody, body));
    }

    @Patch(':id')
    @OrganisationScoped(MANAGE)
    @ApiBody({ schema: openApiSchema(UpdatePartyBody) })
    @ApiOkResponse({ schema: openApiSchema(Party) })
    update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
      return this.service.updateParty(ctx, kind, parse(Uuid, id), parse(UpdatePartyBody, body));
    }
  }
  Object.defineProperty(PartyController, 'name', { value: kind === 'customer' ? 'CustomersController' : 'SuppliersController' });
  return PartyController;
};

export const CustomersController = partyController('customer', 'customers');
export const SuppliersController = partyController('supplier', 'suppliers');

@ApiTags('parts')
@ApiBearerAuth()
@Controller('parts')
export class PartsController {
  constructor(private readonly service: MasterDataService) {}

  @Get()
  @OrganisationScoped(READ)
  @listQueries([ApiQuery({ name: 'customerId', required: false, schema: { type: 'string', format: 'uuid' } })])
  @ApiOkResponse({ schema: openApiSchema(pageSchema(PartSummary)) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.listParts(ctx, parse(PartListQuery, query));
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreatePartBody) })
  @ApiCreatedResponse({ schema: openApiSchema(PartDetail) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createPart(ctx, parse(CreatePartBody, body));
  }

  @Get(':id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(PartDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.getPart(ctx, parse(Uuid, id));
  }

  @Patch(':id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdatePartBody) })
  @ApiOkResponse({ schema: openApiSchema(PartDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updatePart(ctx, parse(Uuid, id), parse(UpdatePartBody, body));
  }

  /** Add a customer the part is sold to (with the customer's own part number). */
  @Post(':id/customers')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AddPartCustomerBody) })
  @ApiCreatedResponse({ schema: openApiSchema(PartDetail) })
  addCustomer(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addPartCustomer(ctx, parse(Uuid, id), parse(AddPartCustomerBody, body));
  }

  @Post(':id/revisions')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateRevisionBody) })
  @ApiCreatedResponse({ schema: openApiSchema(PartRevision) })
  createRevision(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createRevision(ctx, parse(Uuid, id), parse(CreateRevisionBody, body));
  }
}

@ApiTags('parts')
@ApiBearerAuth()
@Controller('part-revisions')
export class PartRevisionsController {
  constructor(private readonly service: MasterDataService) {}

  /** Edit a draft revision (released revisions are locked). */
  @Patch(':id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateRevisionBody) })
  @ApiOkResponse({ schema: openApiSchema(PartRevision) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateRevision(ctx, parse(Uuid, id), parse(UpdateRevisionBody, body));
  }

  /** Release a draft; the previously released revision becomes superseded. */
  @Post(':id/release')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ schema: openApiSchema(PartRevision) })
  release(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.transitionRevision(ctx, parse(Uuid, id), 'released');
  }

  /** Retire a revision (draft, released or superseded). */
  @Post(':id/obsolete')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ schema: openApiSchema(PartRevision) })
  obsolete(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.transitionRevision(ctx, parse(Uuid, id), 'obsolete');
  }
}

@ApiTags('parts')
@ApiBearerAuth()
@Controller('part-customers')
export class PartCustomersController {
  constructor(private readonly service: MasterDataService) {}

  /** Change the customer's part number, or make this the primary customer. */
  @Patch(':id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdatePartCustomerBody) })
  @ApiOkResponse({ schema: openApiSchema(PartDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updatePartCustomer(ctx, parse(Uuid, id), parse(UpdatePartCustomerBody, body));
  }

  @Delete(':id')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ schema: openApiSchema(PartDetail) })
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.removePartCustomer(ctx, parse(Uuid, id));
  }
}
