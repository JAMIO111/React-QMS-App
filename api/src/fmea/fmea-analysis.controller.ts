import { Body, Controller, Delete, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { FmeaAnalysisService } from './fmea-analysis.service';
import {
  CreateCauseBody,
  CreateEffectBody,
  CreateFailureModeBody,
  CreateFunctionBody,
  CreateItemBody,
  UpdateCauseBody,
  UpdateEffectBody,
  UpdateFailureModeBody,
  UpdateFunctionBody,
  UpdateItemBody,
} from './fmea.schemas';

const MANAGE = 'fmea.manage';
const ANSWER = 'The whole revision: the analysis net, the model it is scored with and what it still needs';

/** FMEA (FM3): the analysis of a draft revision, node by node. Each command answers with the whole revision. */
@ApiTags('fmea')
@ApiBearerAuth()
@Controller()
export class FmeaAnalysisController {
  constructor(private readonly service: FmeaAnalysisService) {}

  @Post('fmea-revisions/:id/items')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateItemBody) })
  @ApiCreatedResponse({ description: `Adds an item to the structure (system, sub-system, component; or process item, step, work element). ${ANSWER}` })
  addItem(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addItem(ctx, parse(Uuid, id), parse(CreateItemBody, body));
  }

  @Patch('fmea-items/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateItemBody) })
  @ApiOkResponse({ description: `Changes an item (its kind never changes). ${ANSWER}` })
  updateItem(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateItem(ctx, parse(Uuid, id), parse(UpdateItemBody, body));
  }

  @Delete('fmea-items/:id')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: `Removes an item and everything under it. ${ANSWER}` })
  removeItem(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.remove(ctx, 'item', parse(Uuid, id));
  }

  @Post('fmea-items/:id/functions')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateFunctionBody) })
  @ApiCreatedResponse({ description: `Adds a function to an item. ${ANSWER}` })
  addFunction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addFunction(ctx, parse(Uuid, id), parse(CreateFunctionBody, body));
  }

  @Patch('fmea-functions/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateFunctionBody) })
  @ApiOkResponse({ description: `Changes a function. ${ANSWER}` })
  updateFunction(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateFunction(ctx, parse(Uuid, id), parse(UpdateFunctionBody, body));
  }

  @Delete('fmea-functions/:id')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: `Removes a function and its failure modes. ${ANSWER}` })
  removeFunction(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.remove(ctx, 'function', parse(Uuid, id));
  }

  @Post('fmea-functions/:id/failure-modes')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateFailureModeBody) })
  @ApiCreatedResponse({ description: `Adds a failure mode to a function. ${ANSWER}` })
  addFailureMode(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addFailureMode(ctx, parse(Uuid, id), parse(CreateFailureModeBody, body));
  }

  @Patch('fmea-failure-modes/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateFailureModeBody) })
  @ApiOkResponse({ description: `Changes a failure mode. ${ANSWER}` })
  updateFailureMode(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateFailureMode(ctx, parse(Uuid, id), parse(UpdateFailureModeBody, body));
  }

  @Delete('fmea-failure-modes/:id')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: `Removes a failure mode with its effects and causes. ${ANSWER}` })
  removeFailureMode(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.remove(ctx, 'failure_mode', parse(Uuid, id));
  }

  @Post('fmea-failure-modes/:id/effects')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateEffectBody) })
  @ApiCreatedResponse({ description: `Adds an effect (with its severity) to a failure mode; its causes are scored again. ${ANSWER}` })
  addEffect(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addEffect(ctx, parse(Uuid, id), parse(CreateEffectBody, body));
  }

  @Patch('fmea-effects/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateEffectBody) })
  @ApiOkResponse({ description: `Changes an effect; the causes of its failure mode are scored again. ${ANSWER}` })
  updateEffect(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateEffect(ctx, parse(Uuid, id), parse(UpdateEffectBody, body));
  }

  @Delete('fmea-effects/:id')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: `Removes an effect; the causes are scored again. ${ANSWER}` })
  removeEffect(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.remove(ctx, 'effect', parse(Uuid, id));
  }

  @Post('fmea-failure-modes/:id/causes')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateCauseBody) })
  @ApiCreatedResponse({ description: `Adds a cause with its controls and occurrence / detection ratings; the database works out RPN and priority. ${ANSWER}` })
  addCause(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.addCause(ctx, parse(Uuid, id), parse(CreateCauseBody, body));
  }

  @Patch('fmea-causes/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateCauseBody) })
  @ApiOkResponse({ description: `Changes a cause; the priority is worked out again. ${ANSWER}` })
  updateCause(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateCause(ctx, parse(Uuid, id), parse(UpdateCauseBody, body));
  }

  @Delete('fmea-causes/:id')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: `Removes a cause. ${ANSWER}` })
  removeCause(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.remove(ctx, 'cause', parse(Uuid, id));
  }

  @Post('fmea-revisions/:id/use-latest-model')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: `Moves a draft to the organisation's latest rating model and scores every cause again. ${ANSWER}` })
  useLatestModel(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.useLatestModel(ctx, parse(Uuid, id));
  }
}
