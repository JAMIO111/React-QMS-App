import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { GoLiveChecklist, OnboardingState, SetStepBody } from './onboarding.schemas';
import { OnboardingService } from './onboarding.service';

const MANAGE = 'organisation.manage';

/** The set-up wizard of the organisation named by X-Organisation-Id. Available while the organisation is still gated (billing and set-up are what a gated organisation allows). */
@ApiTags('onboarding')
@ApiBearerAuth()
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly service: OnboardingService) {}

  @Get()
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Where the wizard is: each step, what is required, whether it can be finished', schema: openApiSchema(OnboardingState) })
  state(@Ctx() ctx: RequestContext) {
    return this.service.state(ctx);
  }

  @Get('checklist')
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'The go-live checklist: what is in place, what is still needed (required) and what is recommended', schema: openApiSchema(GoLiveChecklist) })
  checklist(@Ctx() ctx: RequestContext) {
    return this.service.checklist(ctx);
  }

  @Put('step')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(SetStepBody) })
  @ApiOkResponse({ description: 'Marks details, security or team done, skipped or pending again', schema: openApiSchema(OnboardingState) })
  setStep(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.setStep(ctx, parse(SetStepBody, body));
  }

  @Post('complete')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Finishes the wizard when everything required is in place (409 onboarding_rule otherwise)', schema: openApiSchema(OnboardingState) })
  complete(@Ctx() ctx: RequestContext) {
    return this.service.complete(ctx);
  }
}
