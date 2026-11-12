import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { parse } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { REMINDER_AREAS } from './reminder-paths';
import { RemindersService } from './reminders.service';

const AreaBody = z.object({ area: z.enum(REMINDER_AREAS), enabled: z.boolean() }).strict();

@ApiTags('reminders')
@ApiBearerAuth()
@Controller()
export class RemindersController {
  constructor(private readonly service: RemindersService) {}

  @Get('reminders/mine')
  @OrganisationScoped()
  @ApiOkResponse({ description: "The caller's own things overdue or due soon, by area (only what they may read), with a link to each; areas switched off are included and marked" })
  mine(@Ctx() ctx: RequestContext) {
    return this.service.mine(ctx);
  }

  @Get('reminder-areas')
  @OrganisationScoped()
  @ApiOkResponse({ description: "The reminder areas with whether each is on for the caller, and the organisation's reminder time and time zone" })
  areas(@Ctx() ctx: RequestContext) {
    return this.service.areas(ctx);
  }

  @Put('reminder-areas')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'Switch one reminder area on or off for the caller; answers with every area' })
  setArea(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(AreaBody, body);
    return this.service.setArea(ctx, b.area, b.enabled);
  }
}
