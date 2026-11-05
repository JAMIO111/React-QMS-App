import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { iso, Row } from '../calibration/calibration.service';
import type { RequestContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { MarkReadBody, NotificationItem, NotificationPreference, SetPreferenceBody } from './notifications.schemas';

/**
 * In-app notifications. What a user sees is decided in the database as that user: their company
 * permission (which includes their subscription package) AND their own preference, falling back to a
 * default that follows their access. This service only reads and writes through those functions.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, unreadOnly: boolean, limit: number): Promise<{ data: NotificationItem[]; unread: number }> {
    return this.database.asUser(ctx, async (db) => {
      const org = ctx.organisationId;
      const rows = (await db.execute<Row>(sql`
        select * from app.visible_notifications(${org}::uuid)
        where (${unreadOnly} = false or read_at is null)
        order by created_at desc limit ${limit}`)).rows;
      const unread = (await db.execute<Row>(sql`select count(*)::int as n from app.visible_notifications(${org}::uuid) where read_at is null`)).rows[0];
      return {
        data: rows.map((r) => ({
          id: r.id as string,
          eventKey: r.event_key as string,
          entityType: r.entity_type as string,
          entityId: r.entity_id as string,
          title: r.title as string,
          body: (r.body as string) ?? null,
          details: (r.details as Record<string, unknown>) ?? {},
          actorUserId: (r.actor_user_id as string) ?? null,
          createdAt: iso(r.created_at)!,
          read: r.read_at != null,
        })),
        unread: Number(unread.n),
      };
    });
  }

  async markRead(ctx: RequestContext, body: MarkReadBody): Promise<void> {
    await this.database.asUser(ctx, (db) =>
      body.all
        ? db.execute(sql`select app.mark_notifications_read(${ctx.organisationId}::uuid, null)`)
        : db.execute(sql`select app.mark_notifications_read(${ctx.organisationId}::uuid, ${body.ids!}::uuid[])`),
    );
  }

  preferences(ctx: RequestContext): Promise<NotificationPreference[]> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`select * from app.list_notification_preferences(${ctx.organisationId}::uuid)`);
      return res.rows.map((r) => ({
        eventKey: r.key as string,
        group: r.group_name as string,
        entity: r.entity_label as string,
        action: r.action as 'created' | 'updated' | 'deleted',
        description: r.description as string,
        enabled: r.enabled as boolean,
        defaultEnabled: r.default_enabled as boolean,
        overridden: r.overridden as boolean,
      }));
    });
  }

  async setPreference(ctx: RequestContext, body: SetPreferenceBody): Promise<NotificationPreference[]> {
    await this.database.asUser(ctx, (db) =>
      db.execute(sql`select app.set_notification_preference(${ctx.organisationId}::uuid, ${body.eventKey}, ${body.enabled}::boolean)`),
    );
    return this.preferences(ctx);
  }

  async resetPreferences(ctx: RequestContext): Promise<NotificationPreference[]> {
    await this.database.asUser(ctx, (db) => db.execute(sql`select app.reset_notification_preferences(${ctx.organisationId}::uuid)`));
    return this.preferences(ctx);
  }
}
