import { Body, Controller, Delete, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { MarkReadBody, NotificationList, NotificationPreference, NotificationsQuery, SetPreferenceBody } from './notifications.schemas';
import { NotificationsService } from './notifications.service';

const Preferences = z.object({ data: z.array(NotificationPreference) });

/** The signed-in member's own notifications and preferences; every member may use them. */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'Notifications the caller may see and has not switched off, newest first, with the unread count', schema: openApiSchema(NotificationList) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(NotificationsQuery, query);
    return this.notifications.list(ctx, q.unread === 'true', q.limit);
  }

  @Post('notifications/read')
  @HttpCode(204)
  @OrganisationScoped()
  @ApiBody({ schema: openApiSchema(MarkReadBody) })
  @ApiNoContentResponse({ description: 'Marks the given notifications (or all) as read for the caller' })
  async markRead(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    await this.notifications.markRead(ctx, parse(MarkReadBody, body));
  }

  @Get('notification-preferences')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'Events the caller may choose from, with the effective setting and its default (which follows their role and package)', schema: openApiSchema(Preferences) })
  async preferences(@Ctx() ctx: RequestContext) {
    return { data: await this.notifications.preferences(ctx) };
  }

  @Put('notification-preferences')
  @OrganisationScoped()
  @ApiBody({ schema: openApiSchema(SetPreferenceBody) })
  @ApiOkResponse({ description: 'Sets one event on or off; enabled null returns it to the default', schema: openApiSchema(Preferences) })
  async setPreference(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.notifications.setPreference(ctx, parse(SetPreferenceBody, body)) };
  }

  @Delete('notification-preferences')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'Removes every override: all events return to their defaults', schema: openApiSchema(Preferences) })
  async reset(@Ctx() ctx: RequestContext) {
    return { data: await this.notifications.resetPreferences(ctx) };
  }
}
