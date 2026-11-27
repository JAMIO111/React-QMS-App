import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { apiErrorFromDatabase } from '../common/database-errors';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { InvitationMailer, InviteEmailDetails } from './invitation-mailer.service';
import {
  AddDepartmentBody,
  AssignRoleBody,
  BulkInviteBody,
  CreateRoleBody,
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
  UpdateRoleBody,
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
    const email = await this.sendInvitation(ctx, body.email, organisationName, member);
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

  /**
   * The invitation email. Someone at the organisation's single sign-on domains, while it is in use, is sent to the company sign-in instead of
   * being given a password account (docs/sso-plan.md SS6).
   */
  private async sendInvitation(ctx: RequestContext, email: string, organisationName: string, member?: Member) {
    const domain = await this.companySignInDomain(ctx, email);
    const details = await this.inviteDetails(ctx, member);
    return domain ? this.mailer.sendCompanySignIn(email, organisationName, domain, details) : this.mailer.send(email, organisationName, fetch, details);
  }

  /** What the email says besides the organisation: who sent it (the caller), their message, the role and when it expires. */
  private async inviteDetails(ctx: RequestContext, member?: Member): Promise<InviteEmailDetails> {
    const inviterName = await this.database
      .asUser(ctx, async (db) => (await db.execute<{ n: string | null }>(sql`select nullif(btrim(concat_ws(' ', first_name, surname)), '') as n from public.profiles where id = auth.uid()`)).rows[0]?.n ?? null)
      .catch(() => null);
    return { inviterName, message: member?.invite?.message ?? null, roleName: member?.roles?.[0]?.roleName ?? null, expiresAt: member?.invite?.expiresAt ?? null };
  }

  private async companySignInDomain(ctx: RequestContext, email: string): Promise<string | null> {
    const at = email.split('@')[1]?.toLowerCase();
    if (!at) return null;
    const row = await this.database.asApi(
      async (c) => (await c.query(`select mode, domains from app.system_sso_mode($1::uuid)`, [ctx.organisationId])).rows[0] as { mode: string; domains: string[] } | undefined,
      ctx.correlationId,
      'members',
    );
    if (!row || row.mode === 'off') return null;
    return (row.domains ?? []).find((d) => at === d || at.endsWith(`.${d}`)) ?? null;
  }

  /** Sends a pending invitation again (not within a minute, at most ten times) and gives it another 14 days. */
  async resendInvitation(ctx: RequestContext, membershipId: string) {
    const { member, organisationName } = await this.database.asUser(ctx, async (db) => {
      await this.one(db, ctx.organisationId!, membershipId); // 404 for anything outside this organisation
      await db.execute(sql`select app.resend_invitation(${membershipId}::uuid)`);
      const org = await db.execute<{ name: string }>(sql`select name from public.organisations where id = ${ctx.organisationId}::uuid`);
      return { member: await this.one(db, ctx.organisationId!, membershipId), organisationName: org.rows[0].name };
    });
    const email = member.email ? await this.sendInvitation(ctx, member.email, organisationName, member) : ({ sent: false, reason: 'send_failed' } as const);
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

  private async roleRows(db: Db, ctx: RequestContext, onlyId?: string): Promise<z.infer<typeof Role>[]> {
    const res = await db.execute<{ id: string; key: string; name: string; description: string | null; is_system: boolean; permissions: string[]; holders: number }>(sql`
      select r.id, r.key, r.name, r.description, r.is_system,
             coalesce(array_agg(rp.permission_code order by rp.permission_code) filter (where rp.permission_code is not null), '{}') as permissions,
             (select count(distinct a.membership_id)::int from public.user_role_assignments a
               join public.organisation_users m on m.id = a.membership_id and m.status in ('active', 'invited')
              where a.role_id = r.id) as holders
      from public.roles r left join public.role_permissions rp on rp.role_id = r.id
      where r.organisation_id = ${ctx.organisationId}::uuid and (${onlyId ?? null}::uuid is null or r.id = ${onlyId ?? null}::uuid)
      group by r.id
      order by r.is_system desc, r.name`);
    return res.rows.map((r) => ({ id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.is_system, permissions: r.permissions, holders: r.holders }));
  }

  roles(ctx: RequestContext): Promise<z.infer<typeof Role>[]> {
    return this.database.asUser(ctx, (db) => this.roleRows(db, ctx));
  }

  /** What each permission is, which module it belongs to and which seat level that module asks for (information for the role editor). */
  permissions(ctx: RequestContext): Promise<z.infer<typeof Permission>[]> {
    return this.database.asUser(ctx, async (db) => {
      // `needs` = the cheapest seat package that gives the permission (its feature row if it has one, else its module row), so the Operator shows
      // where it is enough (raising an NC, recording an inspection).
      const res = await db.execute<{ code: string; description: string; module: string | null; needs: string | null }>(sql`
        select p.code, p.description, m.name as module,
               (select pl.slug from public.subscription_plans pl
                 where f.id is not null and pl.kind = 'seat' and pl.status = 'active'
                   and coalesce((select case when e.enabled then array_position(array['none', 'view', 'operational', 'full'], e.access_level) else 0 end
                                   from public.subscription_entitlements e
                                  where e.subscription_plan_id = pl.id and e.module_id = f.module_id and (e.feature_id = f.id or e.feature_id is null)
                                  order by (e.feature_id is null) limit 1), 0) >= array_position(array['none', 'view', 'operational', 'full'], f.min_access_level)
                 order by pl.display_order limit 1) as needs
        from public.permissions p
        left join public.features f on f.permission_code = p.code
        left join public.modules m on m.id = f.module_id
        order by coalesce(m.display_order, 9999), coalesce(m.name, 'Administration'), p.code`);
      const known = ['observer', 'operator', 'contributor', 'controller'] as const;
      return res.rows.map((r) => ({
        code: r.code,
        description: r.description,
        module: r.module ?? 'Administration',
        needs: r.needs && (known as readonly string[]).includes(r.needs) ? (r.needs as (typeof known)[number]) : null,
      }));
    });
  }

  /** Makes a custom role (Owner only; the database refuses permissions the person does not hold, roles.manage, duplicate names and the 31st role). */
  createRole(ctx: RequestContext, body: CreateRoleBody): Promise<z.infer<typeof Role>> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`
        select app.save_custom_role(${ctx.organisationId}::uuid, null, ${body.name}, ${body.description ?? null}, string_to_array(${body.permissions.join(',')}, ',')) as id`);
      return (await this.roleRows(db, ctx, res.rows[0].id))[0];
    });
  }

  /** Changes a custom role. What is not sent stays; the permissions replace the list as a whole. A built-in role answers 409 role_rule. */
  updateRole(ctx: RequestContext, id: string, body: UpdateRoleBody): Promise<z.infer<typeof Role>> {
    return this.database.asUser(ctx, async (db) => {
      const current = (await this.roleRows(db, ctx, id))[0];
      if (!current) throw ApiError.notFound('role_not_found', 'Role not found');
      if (current.isSystem) throw new ApiError(409, 'role_rule', 'The built-in roles cannot be changed. Make a copy and change that.');
      await db.execute(sql`
        select app.save_custom_role(${ctx.organisationId}::uuid, ${id}::uuid, ${body.name ?? current.name},
          ${body.description === undefined ? current.description : body.description}, string_to_array(${(body.permissions ?? current.permissions).join(',')}, ','))`);
      return (await this.roleRows(db, ctx, id))[0];
    });
  }

  /** Deletes a custom role nobody holds (409 role_rule says how many people hold it otherwise). */
  deleteRole(ctx: RequestContext, id: string): Promise<void> {
    return this.database.asUser(ctx, async (db) => {
      const current = (await this.roleRows(db, ctx, id))[0];
      if (!current) throw ApiError.notFound('role_not_found', 'Role not found');
      await db.execute(sql`select app.delete_custom_role(${id}::uuid)`);
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
    const company = await db.execute<{ id: string }>(sql`select id from app.member_company_accounts(${organisationId}::uuid) as id`);
    const ids = new Set(company.rows.map((r) => r.id));
    return res.rows.map(toMember).map((m) => ({ ...m, companyAccount: m.userId ? ids.has(m.userId) : false }));
  }

  /** Password members whose address is also a company account at a verified domain (docs/sso-plan.md SS5). */
  async ssoMatches(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`select * from app.sso_member_matches(${ctx.organisationId}::uuid)`);
      return {
        data: r.rows.map((m) => ({
          membershipId: m.membership_id as string,
          passwordUserId: m.password_user_id as string,
          name: (m.name as string) ?? null,
          email: (m.email as string) ?? null,
          memberStatus: m.member_status as string,
          ssoUserId: m.sso_user_id as string,
          ssoCreatedAt: m.sso_created_at ? new Date(m.sso_created_at as string).toISOString() : null,
          ssoLastSignInAt: m.sso_last_sign_in_at ? new Date(m.sso_last_sign_in_at as string).toISOString() : null,
          ssoMember: Boolean(m.sso_member),
        })),
      };
    });
  }

  /** Moves a member's password account onto their company account: the membership and open work move, history stays. */
  async moveToSso(ctx: RequestContext, membershipId: string, ssoUserId: string) {
    return this.database.asUser(ctx, async (db) => {
      const member = await this.one(db, ctx.organisationId!, membershipId);
      if (!member.userId) throw new ApiError(409, 'sso_rule', 'An invitation has no account to move');
      const r = await db.execute<{ id: string }>(sql`select app.move_member_to_sso_account(${ctx.organisationId}::uuid, ${member.userId}::uuid, ${ssoUserId}::uuid) as id`);
      const move = await db.execute<{ moved: Record<string, number>; skipped: Record<string, string> }>(
        sql`select moved, skipped from public.sso_account_moves where id = ${r.rows[0].id}::uuid`,
      );
      return { member: await this.one(db, ctx.organisationId!, membershipId), moved: move.rows[0]?.moved ?? {}, skipped: move.rows[0]?.skipped ?? {} };
    });
  }

  /** "Not the same person": the pair is not offered again. */
  async dismissSsoMatch(ctx: RequestContext, passwordUserId: string, ssoUserId: string) {
    await this.database.asUser(ctx, (db) => db.execute(sql`select app.dismiss_sso_match(${ctx.organisationId}::uuid, ${passwordUserId}::uuid, ${ssoUserId}::uuid)`));
    return this.ssoMatches(ctx);
  }

  private async one(db: Db, organisationId: string, membershipId: string): Promise<Member> {
    const member = (await this.directory(db, organisationId)).find((m) => m.membershipId === membershipId);
    if (!member) throw ApiError.notFound('member_not_found', 'Member not found');
    return member;
  }
}
