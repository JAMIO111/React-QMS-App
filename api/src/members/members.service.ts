import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { apiErrorFromDatabase } from '../common/database-errors';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { InvitationMailer } from './invitation-mailer.service';
import {
  AddDepartmentBody,
  AssignRoleBody,
  BulkInviteBody,
  Invitation,
  InviteBody,
  Member,
  MembershipStatus,
  ORGANISATION_WIDE_ROLE_KEYS,
  Permission,
  Role,
  RoleAssignment,
  TRANSITIONS,
  UpdateDepartmentMembershipBody,
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
  departments: Member['departments'];
  invite: Member['invite'];
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
  departments: r.departments ?? [],
  invite: r.invite ?? null,
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
      // A department is required unless the role is organisation-wide (owner, admin, quality manager).
      const role = await db.execute<{ key: string }>(sql`select key from public.roles where id = ${body.roleId}::uuid and organisation_id = ${ctx.organisationId}::uuid`);
      if (role.rows.length === 0) throw ApiError.badRequest('invalid_reference', 'Role not found in this organisation');
      const departmentIds = [...new Set([...(body.departmentId ? [body.departmentId] : []), ...body.departmentIds])];
      if (departmentIds.length === 0 && !ORGANISATION_WIDE_ROLE_KEYS.includes(role.rows[0].key)) {
        throw ApiError.badRequest('department_required', 'Choose at least one department for this person (only owners, admins and quality managers can be invited without one)');
      }
      if (body.primaryDepartmentId && !departmentIds.includes(body.primaryDepartmentId)) {
        throw ApiError.badRequest('invalid_reference', 'The primary department must be one of the chosen departments');
      }
      if (departmentIds.length) {
        const found = await db.execute(sql`select 1 from public.departments d where d.organisation_id = ${ctx.organisationId}::uuid and d.active
          and d.id = any (string_to_array(${departmentIds.join(',')}, ',')::uuid[])`);
        if (found.rows.length !== departmentIds.length) throw ApiError.badRequest('invalid_reference', 'A department was not found in this organisation, or is no longer active');
      }
      const inserted = await db.execute<{ id: string }>(sql`
        insert into public.organisation_users (organisation_id, invited_email, status, invited_at)
        values (${ctx.organisationId}::uuid, ${body.email}, 'invited', now())
        returning id`);
      const membershipId = inserted.rows[0].id;
      const primary = body.primaryDepartmentId ?? departmentIds[0];
      for (const departmentId of departmentIds) {
        await db.execute(sql`
          insert into public.department_members (organisation_id, department_id, membership_id, is_primary)
          values (${ctx.organisationId}::uuid, ${departmentId}::uuid, ${membershipId}::uuid, ${departmentId === primary})`);
      }
      await db.execute(sql`
        insert into public.user_role_assignments (organisation_id, membership_id, role_id, site_id, department_id)
        values (${ctx.organisationId}::uuid, ${membershipId}::uuid, ${body.roleId}::uuid,
                ${body.siteId ?? null}::uuid, ${body.departmentId ?? null}::uuid)`);
      // Message, expiry, send counters and the reserved seat (QM015 / QM009 roll the whole invitation back).
      await db.execute(sql`select app.set_invitation_details(${membershipId}::uuid, ${body.message ?? null}, ${body.packageSlug ?? null})`);
      const org = await db.execute<{ name: string }>(sql`select name from public.organisations where id = ${ctx.organisationId}::uuid`);
      return { member: await this.one(db, ctx.organisationId!, membershipId), organisationName: org.rows[0].name };
    });
    // Email after the invitation is committed; a failed email never loses the invitation.
    const email = await this.mailer.send(body.email, organisationName);
    return { member, email };
  }

  /**
   * Up to 50 invitations, each independent: one that cannot be sent (already a member, no free seat, a missing department...) never stops the rest.
   * The answer has one result per row, in the order sent.
   */
  async inviteMany(ctx: RequestContext, body: BulkInviteBody) {
    const results: {
      email: string;
      ok: boolean;
      member?: Member;
      emailOutcome?: Awaited<ReturnType<InvitationMailer['send']>>;
      error?: { code: string; message: string };
    }[] = [];
    const seen = new Set<string>();
    for (const row of body.invitations) {
      if (seen.has(row.email)) {
        results.push({ email: row.email, ok: false, error: { code: 'duplicate_in_request', message: 'This address appears twice in the list' } });
        continue;
      }
      seen.add(row.email);
      try {
        const { member, email } = await this.invite(ctx, row);
        results.push({ email: row.email, ok: true, member, emailOutcome: email });
      } catch (error) {
        const api = error instanceof ApiError ? error : apiErrorFromDatabase(error);
        if (!api) throw error;
        const response = api.getResponse();
        results.push({ email: row.email, ok: false, error: { code: api.code, message: typeof response === 'string' ? response : api.message } });
      }
    }
    const invited = results.filter((r) => r.ok).length;
    return { results, invited, failed: results.length - invited };
  }

  /** Sends a pending invitation again (not within a minute, at most ten times) and gives it another 14 days. */
  async resendInvitation(ctx: RequestContext, membershipId: string) {
    const { member, organisationName } = await this.database.asUser(ctx, async (db) => {
      await this.one(db, ctx.organisationId!, membershipId); // 404 for anything outside this organisation
      await db.execute(sql`select app.resend_invitation(${membershipId}::uuid)`);
      const org = await db.execute<{ name: string }>(sql`select name from public.organisations where id = ${ctx.organisationId}::uuid`);
      return { member: await this.one(db, ctx.organisationId!, membershipId), organisationName: org.rows[0].name };
    });
    const email = member.email ? await this.mailer.send(member.email, organisationName) : ({ sent: false, reason: 'send_failed' } as const);
    return { member, email };
  }

  /** Withdraws a pending invitation and frees the seat reserved for it. */
  revokeInvitation(ctx: RequestContext, membershipId: string): Promise<Member> {
    return this.database.asUser(ctx, async (db) => {
      await this.one(db, ctx.organisationId!, membershipId);
      await db.execute(sql`select app.revoke_invitation(${membershipId}::uuid)`);
      return this.one(db, ctx.organisationId!, membershipId);
    });
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
      if (current.status === 'invited') {
        // Revoking an invitation also frees the seat reserved for it.
        await db.execute(sql`select app.revoke_invitation(${membershipId}::uuid)`);
        return this.one(db, ctx.organisationId!, membershipId);
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

  /** Puts a person in a department (optionally as their primary one). */
  addDepartment(ctx: RequestContext, membershipId: string, body: AddDepartmentBody): Promise<Member> {
    return this.database.asUser(ctx, async (db) => {
      const member = await this.one(db, ctx.organisationId!, membershipId);
      if (member.status === 'removed') throw new ApiError(409, 'member_removed', 'A removed member cannot be put in a department');
      const dept = await db.execute(sql`select 1 from public.departments where id = ${body.departmentId}::uuid and organisation_id = ${ctx.organisationId}::uuid and active`);
      if (dept.rows.length === 0) throw ApiError.badRequest('invalid_reference', 'Department not found in this organisation, or no longer active');
      if (member.departments.some((d) => d.departmentId === body.departmentId)) {
        throw new ApiError(409, 'already_in_department', 'This person is already in that department');
      }
      await db.execute(sql`
        insert into public.department_members (organisation_id, department_id, membership_id, is_primary)
        values (${ctx.organisationId}::uuid, ${body.departmentId}::uuid, ${membershipId}::uuid, ${body.primary ?? false})`);
      return this.one(db, ctx.organisationId!, membershipId);
    });
  }

  /** Takes a person out of a department (the membership is kept as history). */
  endDepartmentMembership(ctx: RequestContext, id: string): Promise<Member> {
    return this.database.asUser(ctx, async (db) => {
      const row = await this.departmentMembership(db, ctx, id);
      const updated = await db.execute(sql`update public.department_members set ended_at = now() where id = ${id}::uuid and organisation_id = ${ctx.organisationId}::uuid returning id`);
      if (updated.rows.length === 0) throw ApiError.forbidden('You cannot change a member who outranks you');
      return this.one(db, ctx.organisationId!, row.membershipId);
    });
  }

  setPrimaryDepartment(ctx: RequestContext, id: string, _body: UpdateDepartmentMembershipBody): Promise<Member> {
    return this.database.asUser(ctx, async (db) => {
      const row = await this.departmentMembership(db, ctx, id);
      const updated = await db.execute(sql`update public.department_members set is_primary = true where id = ${id}::uuid and organisation_id = ${ctx.organisationId}::uuid returning id`);
      if (updated.rows.length === 0) throw ApiError.forbidden('You cannot change a member who outranks you');
      return this.one(db, ctx.organisationId!, row.membershipId);
    });
  }

  private async departmentMembership(db: Db, ctx: RequestContext, id: string) {
    const r = await db.execute<{ membership_id: string; ended_at: Date | null }>(sql`
      select membership_id, ended_at from public.department_members where id = ${id}::uuid and organisation_id = ${ctx.organisationId}::uuid`);
    if (r.rows.length === 0) throw ApiError.notFound('department_membership_not_found', 'Department membership not found');
    if (r.rows[0].ended_at) throw new ApiError(409, 'department_rule', 'This department membership has already ended');
    return { membershipId: r.rows[0].membership_id };
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
      const res = await db.execute<{
        membership_id: string; organisation_id: string; organisation_name: string; invited_at: Date | null; invited_by_name: string | null;
        message: string | null; expires_at: Date | null; expired: boolean; roles: { key: string; name: string }[]; departments: string[];
        package_slug: string | null; package_name: string | null;
      }>(sql`select * from app.my_invitations()`);
      return res.rows.map((r) => ({
        membershipId: r.membership_id,
        organisationId: r.organisation_id,
        organisationName: r.organisation_name,
        invitedAt: r.invited_at ? new Date(r.invited_at).toISOString() : null,
        invitedByName: r.invited_by_name,
        message: r.message,
        expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        expired: r.expired,
        roles: r.roles,
        departments: r.departments,
        packageSlug: r.package_slug,
        packageName: r.package_name,
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
