import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { ApImportBody, PreviewBody, SaveFmeaModelBody } from './fmea-model.schemas';
import { FmeaModelService } from './fmea-model.service';

const READ = 'fmea.read';
const APPROVE = 'fmea.approve';

/** FMEA rating model (FM2): the scales, the method that gives a priority (RPN or an action priority grid the organisation enters) and its versions. */
@ApiTags('fmea')
@ApiBearerAuth()
@Controller()
export class FmeaModelController {
  constructor(private readonly service: FmeaModelService) {}

  @Get('fmea-model')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The current model (scales, method, thresholds, action priority grid) and its versions' })
  model(@Ctx() ctx: RequestContext) {
    return this.service.model(ctx);
  }

  @Put('fmea-model')
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(SaveFmeaModelBody) })
  @ApiOkResponse({ description: 'Saves a new version of the model with a reason. FMEAs already rated keep the version they were rated with.' })
  saveModel(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.saveModel(ctx, parse(SaveFmeaModelBody, body));
  }

  @Post('fmea-model/preview')
  @HttpCode(200)
  @OrganisationScoped(READ)
  @ApiBody({ schema: openApiSchema(PreviewBody) })
  @ApiOkResponse({ description: 'What a severity, occurrence and detection come to on a saved version of the model: RPN, priority and whether it needs attention. Nothing is saved.' })
  preview(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.preview(ctx, parse(PreviewBody, body));
  }

  @Post('fmea-model/ap-import')
  @HttpCode(200)
  @OrganisationScoped(APPROVE)
  @ApiBody({ schema: openApiSchema(ApImportBody) })
  @ApiOkResponse({ description: 'Reads an action priority grid from CSV text: the ranges, the lines that could not be read and whether the grid covers every combination. Nothing is saved.' })
  importGrid(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.importGrid(ctx, parse(ApImportBody, body));
  }
}
