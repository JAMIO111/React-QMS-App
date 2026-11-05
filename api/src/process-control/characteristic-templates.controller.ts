import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { CharacteristicTemplatesService } from './characteristic-templates.service';
import {
  CharacteristicTemplate,
  CharacteristicTemplateQuery,
  CreateCharacteristicTemplateBody,
  UpdateCharacteristicTemplateBody,
} from './process-control.schemas';

/** Reusable characteristics for control plans (Settings → Process control). */
@ApiTags('control-plans')
@ApiBearerAuth()
@Controller('characteristic-templates')
export class CharacteristicTemplatesController {
  constructor(private readonly service: CharacteristicTemplatesService) {}

  @Get()
  @OrganisationScoped('process_control.read')
  @ApiQuery({ name: 'includeInactive', required: false, schema: { type: 'boolean', default: false } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(CharacteristicTemplate) })) })
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.service.list(ctx, parse(CharacteristicTemplateQuery, query)) };
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped('process_control.manage')
  @ApiBody({ schema: openApiSchema(CreateCharacteristicTemplateBody) })
  @ApiCreatedResponse({ schema: openApiSchema(CharacteristicTemplate) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateCharacteristicTemplateBody, body));
  }

  @Patch(':id')
  @OrganisationScoped('process_control.manage')
  @ApiBody({ schema: openApiSchema(UpdateCharacteristicTemplateBody) })
  @ApiOkResponse({ schema: openApiSchema(CharacteristicTemplate) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateCharacteristicTemplateBody, body));
  }
}
