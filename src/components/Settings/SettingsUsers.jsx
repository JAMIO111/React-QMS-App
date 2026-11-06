import { useState } from "react";
import Switch from "@/components/ui/Switch";
import Field from "../ui/Field";
import { ApiUnavailable } from "./SettingsOrganisation";
import { describeApiError } from "../../lib/api-client";
import { useAuth } from "../../contexts/AuthProvider";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useToast } from "../../contexts/ToastProvider";
import MenuCard from "../ui/MenuCard";
import {
  useAllDepartments,
  useMemberMutation,
  useMembers,
  usePermissions,
  useRoles,
  useSites,
} from "../../hooks/useQmsApi";
import LoadingScreen from "../ui/LoadingScreen";
import { ORGANISATION_WIDE_ROLE_KEYS, isUnassigned } from "../../lib/departments";

const STATUS_STYLES = {
  active: "bg-green-500/15 text-green-700 dark:text-green-300",
  invited: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  suspended: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  removed: "bg-gray-500/15 text-secondary-text",
};

const EMAIL_NOTES = {
  not_configured:
    "No email was sent (invitation emails are not set up). Ask them to sign up with this address; the invitation will be waiting.",
  existing_account:
    "They already have an account, so no email was sent. They will see the invitation next time they sign in.",
  send_failed:
    "The invitation was created but the email could not be sent. Ask them to sign in with this address.",
};

const button =
  "rounded-lg border border-border-color px-2 py-1 text-sm text-primary-text hover:border-border-dark-color disabled:opacity-50 cursor-pointer";
const select =
  "rounded-lg border border-border-color bg-text-input-color px-2 py-2 text-primary-text shadow-s disabled:opacity-60";

const displayName = (m) =>
  [m.firstName, m.surname].filter(Boolean).join(" ") || m.email || "Unknown";

const departmentLabel = (d, sites) => `${sites.find((x) => x.id === d.siteId)?.code ?? ""} · ${d.name}`.replace(/^ · /, "");

const InviteForm = ({ roles, sites, departments }) => {
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [deptIds, setDeptIds] = useState([]);
  const [primaryId, setPrimaryId] = useState("");
  const [note, setNote] = useState(null);
  const mutation = useMemberMutation();

  const roleKey = roles.find((r) => r.id === roleId)?.key;
  const needsDepartment = !!roleId && !ORGANISATION_WIDE_ROLE_KEYS.includes(roleKey);
  const primary = deptIds.includes(primaryId) ? primaryId : deptIds[0];
  const toggle = (id) => setDeptIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const submit = (e) => {
    e.preventDefault();
    setNote(null);
    if (needsDepartment && deptIds.length === 0) {
      setNote("Choose at least one department for this person.");
      return;
    }
    mutation.mutate(
      {
        action: "invite",
        body: {
          email: email.trim(),
          roleId,
          ...(siteId ? { siteId } : {}),
          ...(deptIds.length ? { departmentIds: deptIds, primaryDepartmentId: primary } : {}),
        },
      },
      {
        onSuccess: (res) => {
          setNote(
            res.email.sent
              ? `Invitation emailed to ${res.member.email}.`
              : EMAIL_NOTES[res.email.reason],
          );
          setEmail("");
          setDeptIds([]);
          setPrimaryId("");
        },
      },
    );
  };

  return (
    <MenuCard
      as="form"
      onSubmit={submit}
      aria-label="Invite member"
      title="Invite someone"
      subtitle="They get an email with a link to join"
      bodyClassName="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Email address"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="flex-1 min-w-56"
        />
        <label className="flex flex-col gap-1 text-sm font-medium text-primary-text">
          Role
          <select
            aria-label="Role"
            className={select}
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            required>
            <option value="" disabled>
              Choose a role
            </option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-primary-text">
          Limited to site
          <select
            aria-label="Limited to site"
            className={select}
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}>
            <option value="">Whole organisation</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} — {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={mutation.isPending}
          className={`${button} h-10`}>
          {mutation.isPending ? "Inviting…" : "Send invitation"}
        </button>
      </div>
      <fieldset className="flex flex-col gap-1" aria-label="Departments">
        <legend className="text-sm font-medium text-primary-text" data-required={needsDepartment || undefined}>
          Departments
        </legend>
        <p className="text-xs text-secondary-text">
          Where this person works. Alerts and notices addressed to a department reach its members.
          {roleId && !needsDepartment ? " Not needed for owners, admins and quality managers." : ""}
        </p>
        {departments.length === 0 ? (
          <p className="text-sm text-secondary-text">No departments yet. Add them under Settings → Organisation.</p>
        ) : (
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {departments.map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-sm text-primary-text">
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={deptIds.includes(d.id)} onChange={() => toggle(d.id)} />
                  {departmentLabel(d, sites)}
                </label>
                {deptIds.includes(d.id) && deptIds.length > 1 && (
                  <label className="flex items-center gap-1 text-xs text-secondary-text">
                    <input type="radio" name="primary-department" checked={primary === d.id} onChange={() => setPrimaryId(d.id)} />
                    primary
                  </label>
                )}
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {mutation.error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(mutation.error)}
        </p>
      )}
      {note && (
        <p role="status" className="text-sm text-secondary-text">
          {note}
        </p>
      )}
    </MenuCard>
  );
};

const MemberRow = ({ member, roles, sites, departments, canManage, isSelf }) => {
  const mutation = useMemberMutation();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const [roleToAdd, setRoleToAdd] = useState("");
  const [deptToAdd, setDeptToAdd] = useState("");
  const siteName = (id) => sites.find((s) => s.id === id)?.code ?? "site";
  const manageable = canManage && !isSelf && member.status !== "removed";

  const run = (vars, success) =>
    mutation.mutate(vars, {
      onSuccess: () =>
        success &&
        showToast({ type: "success", title: "Updated", message: success }),
      onError: (error) =>
        showToast({
          type: "error",
          title: "Not changed",
          message: describeApiError(error),
        }),
    });

  const setStatus = async (status, verb) => {
    if (status === "removed") {
      const ok = await confirm({
        title:
          member.status === "invited"
            ? "Revoke this invitation?"
            : `Remove ${displayName(member)}?`,
        message:
          "They will lose access to this organisation. Their past records and audit history are kept.",
        confirmText: member.status === "invited" ? "Revoke" : "Remove",
        cancelText: "Cancel",
        type: "warning",
      });
      if (!ok) return;
    }
    run(
      { action: "status", membershipId: member.membershipId, body: { status } },
      `${displayName(member)} ${verb}.`,
    );
  };

  return (
    <tr
      className={`border-t border-border-color align-top ${member.status === "removed" ? "opacity-60" : ""}`}>
      <td className="py-3 pr-3">
        <div className="text-primary-text font-medium">
          {displayName(member)}{" "}
          {isSelf && <span className="text-secondary-text text-sm">(you)</span>}
        </div>
        {member.email && member.email !== displayName(member) && (
          <div className="text-secondary-text text-sm">{member.email}</div>
        )}
      </td>
      <td className="py-3 pr-3">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[member.status]}`}>
          {member.status}
        </span>
      </td>
      <td className="py-3 pr-3">
        <ul
          className="flex flex-wrap gap-1.5"
          aria-label={`Roles of ${displayName(member)}`}>
          {member.roles.map((r) => (
            <li
              key={r.assignmentId}
              className="flex items-center gap-1 rounded-full border border-border-color px-2 py-0.5 text-sm text-primary-text">
              {r.roleName}
              {r.siteId && (
                <span className="text-secondary-text">
                  @{siteName(r.siteId)}
                </span>
              )}
              {canManage && member.status !== "removed" && (
                <button
                  type="button"
                  aria-label={`Remove role ${r.roleName} from ${displayName(member)}`}
                  className="ml-0.5 text-secondary-text hover:text-error-color cursor-pointer"
                  disabled={mutation.isPending}
                  onClick={() =>
                    run(
                      { action: "unassign", assignmentId: r.assignmentId },
                      `${r.roleName} removed.`,
                    )
                  }>
                  ×
                </button>
              )}
            </li>
          ))}
          {member.roles.length === 0 && (
            <li className="text-sm text-secondary-text">No roles</li>
          )}
        </ul>
        {canManage && member.status !== "removed" && (
          <form
            className="mt-2 flex gap-2"
            aria-label={`Add role to ${displayName(member)}`}
            onSubmit={(e) => {
              e.preventDefault();
              if (roleToAdd)
                run(
                  {
                    action: "assign",
                    membershipId: member.membershipId,
                    body: { roleId: roleToAdd },
                  },
                  "Role added.",
                );
              setRoleToAdd("");
            }}>
            <select
              aria-label={`Role to add for ${displayName(member)}`}
              className={`${select} py-1 text-sm`}
              value={roleToAdd}
              onChange={(e) => setRoleToAdd(e.target.value)}>
              <option value="">Add role…</option>
              {roles
                .filter(
                  (r) =>
                    !member.roles.some((a) => a.roleId === r.id && !a.siteId),
                )
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </select>
            <button
              type="submit"
              className={button}
              disabled={!roleToAdd || mutation.isPending}>
              Add
            </button>
          </form>
        )}
      </td>
      <td className="py-3 pr-3">
        <ul className="flex flex-wrap gap-1.5" aria-label={`Departments of ${displayName(member)}`}>
          {(member.departments ?? []).map((d) => (
            <li key={d.id} className="flex items-center gap-1 rounded-full border border-border-color px-2 py-0.5 text-sm text-primary-text">
              {d.name}
              <span className="text-secondary-text">@{d.siteName}</span>
              {d.isPrimary ? (
                <span className="rounded-full bg-brand-primary/15 px-1.5 text-xs text-primary-text">primary</span>
              ) : (
                canManage &&
                member.status !== "removed" && (
                  <button
                    type="button"
                    aria-label={`Make ${d.name} the primary department of ${displayName(member)}`}
                    className="text-xs text-secondary-text hover:text-primary-text cursor-pointer"
                    disabled={mutation.isPending}
                    onClick={() => run({ action: "setPrimaryDepartment", departmentMembershipId: d.id }, `${d.name} is now the primary department.`)}>
                    make primary
                  </button>
                )
              )}
              {canManage && member.status !== "removed" && (
                <button
                  type="button"
                  aria-label={`Remove ${displayName(member)} from ${d.name}`}
                  className="ml-0.5 text-secondary-text hover:text-error-color cursor-pointer"
                  disabled={mutation.isPending}
                  onClick={() => run({ action: "endDepartment", departmentMembershipId: d.id }, `Removed from ${d.name}.`)}>
                  ×
                </button>
              )}
            </li>
          ))}
          {(member.departments ?? []).length === 0 && (
            <li className={`text-sm ${isUnassigned(member) ? "text-error-color" : "text-secondary-text"}`}>
              {isUnassigned(member) ? "No department — alerts to departments will not reach them" : "None"}
            </li>
          )}
        </ul>
        {canManage && member.status !== "removed" && (
          <form
            className="mt-2 flex gap-2"
            aria-label={`Add department to ${displayName(member)}`}
            onSubmit={(e) => {
              e.preventDefault();
              if (deptToAdd) run({ action: "addDepartment", membershipId: member.membershipId, body: { departmentId: deptToAdd } }, "Department added.");
              setDeptToAdd("");
            }}>
            <select
              aria-label={`Department to add for ${displayName(member)}`}
              className={`${select} py-1 text-sm`}
              value={deptToAdd}
              onChange={(e) => setDeptToAdd(e.target.value)}>
              <option value="">Add department…</option>
              {departments
                .filter((d) => !(member.departments ?? []).some((m) => m.departmentId === d.id))
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {departmentLabel(d, sites)}
                  </option>
                ))}
            </select>
            <button type="submit" className={button} disabled={!deptToAdd || mutation.isPending}>
              Add
            </button>
          </form>
        )}
      </td>
      <td className="py-3 text-right whitespace-nowrap">
        {manageable && (
          <div className="flex justify-end gap-2">
            {member.status === "active" && (
              <button
                type="button"
                className={button}
                disabled={mutation.isPending}
                onClick={() => setStatus("suspended", "suspended")}>
                Suspend
              </button>
            )}
            {member.status === "suspended" && (
              <button
                type="button"
                className={button}
                disabled={mutation.isPending}
                onClick={() => setStatus("active", "reactivated")}>
                Reactivate
              </button>
            )}
            <button
              type="button"
              className={button}
              disabled={mutation.isPending}
              onClick={() =>
                setStatus(
                  "removed",
                  member.status === "invited"
                    ? "invitation revoked"
                    : "removed",
                )
              }>
              {member.status === "invited" ? "Revoke" : "Remove"}
            </button>
          </div>
        )}
      </td>
    </tr>
  );
};

/** Settings → Users & permissions: members, invitations and roles of the current organisation. */
const SettingsUsers = () => {
  const { user } = useAuth();
  const { can } = usePermissions();
  const members = useMembers();
  const roles = useRoles();
  const sites = useSites();
  const departments = useAllDepartments();
  const [showRemoved, setShowRemoved] = useState(false);
  const canManage = can("members.manage");

  if (members.isLoading || roles.isLoading)
    return <LoadingScreen />;
  if (members.error?.status === 403) {
    return (
      <p className="text-secondary-text p-4">
        You need the members.read permission to see this organisation's members.
      </p>
    );
  }
  if (members.error || roles.error)
    return <ApiUnavailable error={members.error ?? roles.error} />;

  const roleList = roles.data?.data ?? [];
  const siteList = sites.data?.data ?? [];
  const departmentList = departments.data?.data ?? [];
  const unassigned = (members.data?.data ?? []).filter(isUnassigned);
  const all = members.data?.data ?? [];
  const visible = showRemoved ? all : all.filter((m) => m.status !== "removed");

  return (
    <div className="flex flex-col gap-5 w-full">
      <div>
        <h2 className="text-primary-text text-2xl font-semibold">
          Users &amp; permissions
        </h2>
        <p className="text-secondary-text text-sm">
          {canManage
            ? "Invite people, give them roles and control their access. You can only grant roles whose permissions you hold yourself."
            : "Who has access to this organisation. An administrator can make changes."}
        </p>
      </div>

      {canManage && <InviteForm roles={roleList} sites={siteList} departments={departmentList} />}

      {unassigned.length > 0 && (
        <p role="status" className="rounded-lg border border-border-color p-3 text-sm text-primary-text">
          {unassigned.length} {unassigned.length === 1 ? "person has" : "people have"} no department
          ({unassigned.map(displayName).join(", ")}). Alerts addressed to a department will not reach them until they are added to one.
        </p>
      )}

      <MenuCard
        aria-label="Members"
        title="Members"
        subtitle="People in the organisation and their roles"
        action={
          <Switch
            className="text-sm text-secondary-text"
            checked={showRemoved}
            onChange={(e) => setShowRemoved(e.target.checked)}>
            Show removed
          </Switch>
        }>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-sm text-secondary-text">
                <th className="py-2 pr-3 font-medium">Person</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Roles</th>
                <th className="py-2 pr-3 font-medium">Departments</th>
                <th className="py-2 font-medium sr-only">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((m) => (
                <MemberRow
                  key={m.membershipId}
                  member={m}
                  roles={roleList}
                  sites={siteList}
                  departments={departmentList}
                  canManage={canManage}
                  isSelf={m.userId === user?.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      </MenuCard>

      <MenuCard
        aria-label="Roles"
        title="Roles"
        subtitle="What each role can do"
        bodyClassName="flex flex-col gap-2">
        {roleList.map((r) => (
          <details key={r.id} className="text-primary-text">
            <summary className="cursor-pointer">
              <span className="font-medium">{r.name}</span>{" "}
              <span className="text-secondary-text text-sm">
                — {r.description}
              </span>
            </summary>
            <ul className="mt-1 ml-5 list-disc text-sm text-secondary-text">
              {r.permissions.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </details>
        ))}
      </MenuCard>
    </div>
  );
};

export default SettingsUsers;
