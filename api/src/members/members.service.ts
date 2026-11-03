import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { InvitationMailer } from './invitation-mailer.service';
import {
  AssignRoleBody,
  Invitation,
  InviteBody,
  Member,
  MembershipStatus,
  Permission,
  Role,
  RoleAssignment,
  TRANSITIONS,
  UpdateMemberBody,
} from './members.schemas';

interface MemberRow {
  membership_id: string;
  user_id: string | null;
  email: string | null;
  first_name: string | null;
  surname: string | null;
  job_title: string | null;
  status: MembershipStatus;
  invited_at: Date | null;
  joined_at: Date | null;
  roles: z.infer<typeof RoleAssignment>[];
}

const toMember = (r: MemberRow): Member => ({
  membershipId: r.membership_id,
  userId: r.user_id,
  email: r.email,
  firstName: r.first_name,
  surname: r.surname,
  jobTitle: r.job_title,
  status: r.status,
  invitedAt: r.invited_at ? new Date(r.invited_at).toISOString() : null,
  joinedAt: r.joined_at ? new Date(r.joined_at).toISOString() : null,
  roles: r.roles,
});

/**
 * Members, invitations and role assignments. Authorisation is enforced twice: the controller's
 * @OrganisationScoped permission and the database's RLS policies (members.manage, no privilege
 * escalation, cannot manage yourself or anyone holding permissions you lack, last Owner kept).
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly mailer: InvitationMailer,
  ) {}

  list(ctx: RequestContext): Promise<Member[]> {
    return this.database.asUser(ctx, (db) => this.directory(db, ctx.organisationId!));
  }

  async invite(ctx: RequestContext, body: InviteBody) {
    const { member, organisationName } = await this.database.asUser(ctx, async (db) => {
      const existing = (await this.directory(db, ctx.organisationId!)).find(
        (m) => m.email?.toLowerCase() === body.email && m.status !== 'removed',
      );
      if (existing) {
        throw new ApiError(409, existing.status === 'invited' ? 'already_invited' : 'already_member',
          existing.status === 'invited' ? 'This email address already has a pending invitation' : 'This person is already a member of the organisation');
      }
      const inserted = await db.execute<{ id: string }>(sql`
        insert into public.organisation_users (organisation_id, invited_email, status, invited_at)
        values (${ctx.organisationId}::uuid, ${body.email}, 'invited', now())
        returning id`);
      const membershipId = inserted.rows[0].id;
      await db.execute(sql`
        insert into public.user_role_assignments (organisation_id, membership_id, role_id, site_id, department_id)
        values (${ctx.organisationId}::uuid, ${membershipId}::uuid, ${body.roleId}::uuid,
                ${body.siteId ?? null}::uuid, ${body.departmentId ?? null}::uuid)`);
      const org = await db.execute<{ name: string }>(sql`select name from public.organisations where id = ${ctx.organisationId}::uuid`);
      return { member: await this.one(db, ctx.organisationId!, membershipId), organisationName: org.rows[0].name };
    });
    // Email after the invitation is committed; a failed email never loses the invitation.
    const email = await this.mailer.send(body.email, organisationName);
    return { member, email };
  }

  updateStatus(ctx: RequestContext, membershipId: string, body: UpdateMemberBody): Promise<Member> {
    return this.database.asUser(ctx, async (db) => {
      const current = await this.one(db, ctx.organisationId!, membershipId);
      if (current.userId === ctx.user.id) {
        throw ApiError.forbidden('You cannot change your own membership status');
      }
      if (current.status === body.status) return current;
      if (!TRANSITIONS[current.status].includes(body.status)) {
        throw new ApiError(409, 'invalid_transition', `A ${current.status} membership cannot become ${body.status}`);
      }
      const updated = await db.execute(sql`
        update public.organisation_users set status = ${body.status}
        where id = ${membershipId}::uuid and organisation_id = ${ctx.organisationId}::uuid
        returning id`);
      if (updated.rows.length === 0) {
        throw ApiError.forbidden('You cannot manage a member who holds permissions you do not have');
      }
      return this.one(db, ctx.organisationId!, membershipId);
    });
  }

  assignRole(ctx: RequestContext, membershipId: string, body: AssignRoleBody): Promise<Member> {
    return this.database.asUser(ctx, async (db) => {
      const member = await this.one(db, ctx.organisationId!, membershipId);
      if (member.status === 'removed') throw new ApiError(409, 'member_removed', 'Roles cannot be given to a removed member');
      const role = await db.execute(sql`select 1 from public.roles where id = ${body.roleId}::uuid and organisation_id = ${ctx.organisationId}::uuid`);
      if (role.rows.length === 0) throw ApiError.badRequest('invalid_reference', 'Role not found in this organisation');
      await db.execute(sql`
        insert into public.user_role_assignments (organisation_id, membership_id, role_id, site_id, department_id)
        values (${ctx.organisationId}::uuid, ${membershipId}::uuid, ${body.roleId}::uuid,
                ${body.siteId ?? null}::uuid, ${body.departmentId ?? null}::uuid)`);
      return this.one(db, ctx.organisationId!, membershipId);
    });
  }

  removeAssignment(ctx: RequestContext, assignmentId: string): Promise<void> {
    return this.database.asUser(ctx, async (db) => {
      const visible = await db.execute(sql`
        select 1 from public.user_role_assignments where id = ${assignmentId}::uuid and organisation_id = ${ctx.organisationId}::uuid`);
      if (visible.rows.length === 0) throw ApiError.notFound('assignment_not_found', 'Role assignment not found');
      const deleted = await db.execute(sql`
        delete from public.user_role_assignments where id = ${assignmentId}::uuid and organisation_id = ${ctx.organisationId}::uuid
        returning id`);
      if (deleted.rows.length === 0) {
        throw ApiError.forbidden('You cannot remove a role you could not grant, or change a member who outranks you');
      }
      // The last-owner rule is checked at commit (QM001 -> 409 last_owner).
    });
  }

  roles(ctx: RequestContext): Promise<z.infer<typeof Role>[]> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string; key: string; name: string; description: string | null; is_system: boolean; permissions: string[] }>(sql`
        select r.id, r.key, r.name, r.description, r.is_system,
               coalesce(array_agg(rp.permission_code order by rp.permission_code) filter (where rp.permission_code is not null), '{}') as permissions
        from public.roles r left join public.role_permissions rp on rp.role_id = r.id
        where r.organisation_id = ${ctx.organisationId}::uuid
        group by r.id
        order by r.is_system desc, r.name`);
      return res.rows.map((r) => ({ id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.is_system, permissions: r.permissions }));
    });
  }

  permissions(ctx: RequestContext): Promise<z.infer<typeof Permission>[]> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ code: string; description: string }>(sql`select code, description from public.permissions order by code`);
      return res.rows;
    });
  }

  myInvitations(ctx: RequestContext): Promise<z.infer<typeof Invitation>[]> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ membership_id: string; organisation_id: string; organisation_name: string; invited_at: Date | null; invited_by_name: string | null }>(
        sql`select * from app.my_invitations()`,
      );
      return res.rows.map((r) => ({
        membershipId: r.membership_id,
        organisationId: r.organisation_id,
        organisationName: r.organisation_name,
        invitedAt: r.invited_at ? new Date(r.invited_at).toISOString() : null,
        invitedByName: r.invited_by_name,
      }));
    });
  }

  async accept(ctx: RequestContext, membershipId: string): Promise<{ organisationId: string }> {
    try {
      return await this.database.asUser(ctx, async (db) => {
        const res = await db.execute<{ organisation_id: string }>(sql`select app.accept_invitation(${membershipId}::uuid) as organisation_id`);
        return { organisationId: res.rows[0].organisation_id };
      });
    } catch (error) {
      const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
      if (code === 'P0002') throw ApiError.notFound('invitation_not_found', 'Invitation not found');
      throw error;
    }
  }

  private async directory(db: Db, organisationId: string): Promise<Member[]> {
    const res = await db.execute<MemberRow & Record<string, unknown>>(sql`select * from app.list_members(${organisationId}::uuid)`);
    return res.rows.map(toMember);
  }

  private async one(db: Db, organisationId: string, membershipId: string): Promise<Member> {
    const member = (await this.directory(db, organisationId)).find((m) => m.membershipId === membershipId);
    if (!member) throw ApiError.notFound('member_not_found', 'Member not found');
    return member;
  }
}
