import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  CUSTOM_FIELD_ENTITIES,
  CreateCustomFieldBody,
  CustomFieldDefinition,
  CustomFieldList,
  CustomFieldsQuery,
  CustomValuesBatchQuery,
  CustomValuesQuery,
  CustomValuesResponse,
  ReorderCustomFieldsBody,
  RetireCustomFieldBody,
  SetCustomValuesBody,
  UpdateCustomFieldBody,
} from './custom-fields.schemas';
import { CustomFieldsService } from './custom-fields.service';

const ENTITY_DOC = `Kind of record: ${CUSTOM_FIELD_ENTITIES.join(', ')}`;

/** The organisation's custom fields: every member reads the definitions; custom_fields.manage defines them. */
@ApiTags('custom-fields')
@ApiBearerAuth()
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Get()
  @OrganisationScoped()
  @ApiQuery({ name: 'entityType', required: false, description: ENTITY_DOC })
  @ApiQuery({ name: 'includeRetired', required: false, description: 'true also lists retired fields' })
  @ApiOkResponse({ description: 'Definitions in display order, the limit per kind of record, and every kind with its stages and count in use', schema: openApiSchema(CustomFieldList) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(CustomFieldsQuery, query);
    return this.fields.list(ctx, q.entityType, q.includeRetired ?? false);
  }

  @Get('people')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'Active members a person field can name: { data: [{ id (user id), name }] }' })
  people(@Ctx() ctx: RequestContext) {
    return this.fields.people(ctx);
  }

  @Post()
  @OrganisationScoped('custom_fields.manage')
  @ApiBody({ schema: openApiSchema(CreateCustomFieldBody) })
  @ApiCreatedResponse({ description: 'Adds a field (key made from the label unless given). 409 custom_field_rule at 20 in use, for a label already used, bad options…', schema: openApiSchema(CustomFieldDefinition) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.fields.create(ctx, parse(CreateCustomFieldBody, body));
  }

  @Put('order')
  @OrganisationScoped('custom_fields.manage')
  @ApiBody({ schema: openApiSchema(ReorderCustomFieldsBody) })
  @ApiOkResponse({ description: 'Sets the display order (every field of the kind once, retired ones included)', schema: openApiSchema(CustomFieldList) })
  reorder(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(ReorderCustomFieldsBody, body);
    return this.fields.reorder(ctx, b.entityType, b.ids);
  }

  @Patch(':id')
  @OrganisationScoped('custom_fields.manage')
  @ApiBody({ schema: openApiSchema(UpdateCustomFieldBody) })
  @ApiOkResponse({ description: 'Changes a field. Its key and type never change; options are switched off, never removed.', schema: openApiSchema(CustomFieldDefinition) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.fields.update(ctx, parse(Uuid, id), parse(UpdateCustomFieldBody, body));
  }

  @Post(':id/retire')
  @OrganisationScoped('custom_fields.manage')
  @ApiBody({ schema: openApiSchema(RetireCustomFieldBody) })
  @ApiOkResponse({ description: 'Retires a field with a reason; its values stay readable', schema: openApiSchema(CustomFieldDefinition) })
  retire(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.fields.retire(ctx, parse(Uuid, id), parse(RetireCustomFieldBody, body).reason);
  }

  @Post(':id/reactivate')
  @OrganisationScoped('custom_fields.manage')
  @ApiOkResponse({ description: 'Brings a retired field back (within the limit)', schema: openApiSchema(CustomFieldDefinition) })
  reactivate(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.fields.reactivate(ctx, parse(Uuid, id));
  }
}

/** A record's custom values: read with the record's read permission, filled in with its edit permission (the database decides). */
@ApiTags('custom-fields')
@ApiBearerAuth()
@Controller('custom-values')
export class CustomValuesController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Get()
  @OrganisationScoped()
  @ApiQuery({ name: 'entityType', description: ENTITY_DOC })
  @ApiQuery({ name: 'ids', description: 'Comma-separated record ids (≤ 500)' })
  @ApiOkResponse({ description: 'The values of the records the caller can read, by record id (records without values are left out)' })
  batch(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(CustomValuesBatchQuery, query);
    return this.fields.batch(ctx, q.entityType, q.ids);
  }

  @Get(':id')
  @OrganisationScoped()
  @ApiQuery({ name: 'entityType', description: ENTITY_DOC })
  @ApiOkResponse({ description: 'One record\'s values; 404 when the caller cannot read the record', schema: openApiSchema(CustomValuesResponse) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return this.fields.values(ctx, parse(CustomValuesQuery, query).entityType, parse(Uuid, id));
  }

  @Put(':id')
  @OrganisationScoped()
  @ApiBody({ schema: openApiSchema(SetCustomValuesBody) })
  @ApiOkResponse({ description: 'Merges values (null, "" or [] clears one). 409 custom_field_rule for a bad value, a locked record or clearing a required one; 403 without the record\'s edit permission.', schema: openApiSchema(CustomValuesResponse) })
  set(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(SetCustomValuesBody, body);
    return this.fields.setValues(ctx, b.entityType, parse(Uuid, id), b.values);
  }
}
