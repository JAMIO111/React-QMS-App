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
import { useSeatAssignments, useSubscriptionMutation, useSubscriptionOverview } from "../../hooks/useSubscription";
import ComboField from "../ui/ComboField";
import RowActionsMenu from "../ui/RowActionsMenu";
import { TextAreaField } from "../master-data/shared";
import { XIcon } from "@/components/icons";
import { ORGANISATION_WIDE_ROLE_KEYS, isUnassigned } from "../../lib/departments";
import { expiresIn } from "../../lib/onboarding";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";

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

const displayName = (m) =>
  [m.firstName, m.surname].filter(Boolean).join(" ") || m.email || "Unknown";

const initials = (m) =>
  ([m.firstName?.[0], m.surname?.[0]].filter(Boolean).join("") || m.email?.[0] || "?").toUpperCase();

const departmentLabel = (d, sites) => `${sites.find((x) => x.id === d.siteId)?.code ?? ""} · ${d.name}`.replace(/^ · /, "");

const chip = "flex items-center gap-1 rounded-full border border-border-color bg-secondary-bg px-2 py-0.5 text-sm text-primary-text";

const InviteForm = ({ roles, sites, departments }) => {
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState(null);
  const [siteId, setSiteId] = useState(null);
  const [deptIds, setDeptIds] = useState([]);
  const [primaryId, setPrimaryId] = useState("");
  const [note, setNote] = useState(null);
  const [message, setMessage] = useState("");
  const [packageSlug, setPackageSlug] = useState(null);
  const mutation = useMemberMutation();
  const { can } = usePermissions();
  const seatOverview = useSubscriptionOverview();
  const seatItems = seatOverview.data?.items ?? [];
  const canGivePackages = can("subscription.seats") && seatItems.length > 0;

  const roleKey = roles.find((r) => r.id === roleId)?.key;
  const needsDepartment = !!roleId && !ORGANISATION_WIDE_ROLE_KEYS.includes(roleKey);
  const primary = deptIds.includes(primaryId) ? primaryId : deptIds[0];
  const toggle = (id) => setDeptIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const submit = (e) => {
    e.preventDefault();
    setNote(null);
    if (!roleId) {
      setNote("Choose a role for this person.");
      return;
    }
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
          ...(message.trim() ? { message: message.trim() } : {}),
          ...(packageSlug ? { packageSlug } : {}),
        },
      },
      {
        onSuccess: (res) => {
          setNote(res.email.sent ? `Invitation emailed to ${res.member.email}.` : EMAIL_NOTES[res.email.reason]);
          setEmail("");
          setMessage("");
          setPackageSlug(null);
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
      noValidate
      aria-label="Invite member"
      title="Invite someone"
      subtitle="They get an email with a link to join"
      bodyClassName="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Email address" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <ComboField label="Role" value={roleId} onChange={setRoleId} required placeholder="Choose a role" options={roles.map((r) => ({ value: r.id, label: r.name, hint: r.description }))} />
        <ComboField
          label="Limited to site"
          value={siteId}
          onChange={setSiteId}
          placeholder="Whole organisation"
          hint="Leave empty for the whole organisation"
          options={sites.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` }))}
        />
      </div>
      <fieldset className="flex flex-col gap-1" aria-label="Departments">
        <legend className="text-sm font-medium text-secondary-text" data-required={needsDepartment || undefined}>
          Departments
        </legend>
        <p className="text-xs text-secondary-text">
          Where this person works. Alerts and notices addressed to a department reach its members.
          {roleId && !needsDepartment ? " Not needed for owners, admins and quality managers." : ""}
        </p>
        {departments.length === 0 ? (
          <p className="text-sm text-secondary-text">No departments yet. Add them under Settings → Organisation.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {departments.map((d) => {
              const on = deptIds.includes(d.id);
              return (
                <li key={d.id} className={`${chip} ${on ? "border-brand-primary" : ""}`}>
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input type="checkbox" checked={on} onChange={() => toggle(d.id)} />
                    {departmentLabel(d, sites)}
                  </label>
                  {on && deptIds.length > 1 && (
                    <label className="ml-1 flex items-center gap-1 text-xs text-secondary-text">
                      <input type="radio" name="primary-department" checked={primary === d.id} onChange={() => setPrimaryId(d.id)} />
                      primary
                    </label>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {canGivePackages && (
          <ComboField
            label="Seat"
            value={packageSlug}
            onChange={setPackageSlug}
            placeholder="No seat yet"
            hint="Reserved now, taken up when they join"
            options={seatItems.map((i) => ({ value: i.planSlug, label: i.planName, hint: `${i.available} left`, disabled: i.available < 1 }))}
          />
        )}
        <TextAreaField label="Message (optional)" className={canGivePackages ? "md:col-span-2" : "md:col-span-3"} rows={2} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} />
      </div>
      {mutation.error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(mutation.error)}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-sm text-secondary-text">{note}</p>
        <CTAButton buttonType="submit" disabled={mutation.isPending} type="main" size="md">
          {mutation.isPending ? "Inviting…" : "Send invitation"}
        </CTAButton>
      </div>
    </MenuCard>
  );
};

/** One person: who they are, their status, and the three things a manager sets — roles, departments and seat. */
const MemberCard = ({ member, roles, sites, departments, canManage, isSelf, seat, seatItems, seatsVisible, canAssignSeats }) => {
  const mutation = useMemberMutation();
  const seatMutation = useSubscriptionMutation();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const name = displayName(member);
  const siteName = (id) => sites.find((s) => s.id === id)?.code ?? "site";
  const editable = canManage && member.status !== "removed";
  const manageable = canManage && !isSelf && member.status !== "removed";

  const handlers = (success) => ({
    onSuccess: () => success && showToast({ type: "success", title: "Updated", message: success }),
    onError: (error) => showToast({ type: "error", title: "Not changed", message: describeApiError(error) }),
  });
  const run = (vars, success) => mutation.mutate(vars, handlers(success));

  const setStatus = async (status, verb) => {
    if (status === "removed") {
      const ok = await confirm({
        title: member.status === "invited" ? "Revoke this invitation?" : `Remove ${name}?`,
        message: "They will lose access to this organisation. Their past records and audit history are kept.",
        confirmText: member.status === "invited" ? "Revoke" : "Remove",
        cancelText: "Cancel",
        type: "warning",
      });
      if (!ok) return;
    }
    run({ action: "status", membershipId: member.membershipId, body: { status } }, `${name} ${verb}.`);
  };

  const changeSeat = async (slug) => {
    const current = seat?.slug ?? null;
    if ((slug ?? null) === current) return;
    if (!slug) {
      const ok = await confirm({
        title: `Remove ${name}'s seat?`,
        message: "They keep their membership and roles but lose what the seat gives them. Their records are kept.",
        confirmText: "Remove seat",
        cancelText: "Cancel",
        type: "warning",
      });
      if (ok) seatMutation.mutate({ action: "remove", membershipId: member.membershipId }, handlers(`${name} no longer has a seat.`));
      return;
    }
    const item = seatItems.find((i) => i.planSlug === slug);
    const ok = await confirm({
      title: `Give ${name} a ${item?.planName ?? slug} seat?`,
      message: `This uses one of the ${item?.available ?? 0} free ${item?.planName ?? slug} seats.${seat ? ` Their ${seat.name} seat is released.` : ""}`,
      confirmText: "Assign",
      cancelText: "Cancel",
      type: "info",
    });
    if (ok) seatMutation.mutate({ action: "assign", membershipId: member.membershipId, planSlug: slug }, handlers(`${name} now has a ${item?.planName ?? slug} seat.`));
  };

  const actions = manageable
    ? [
        member.status === "active" && { label: "Suspend", onSelect: () => setStatus("suspended", "suspended") },
        member.status === "suspended" && { label: "Reactivate", onSelect: () => setStatus("active", "reactivated") },
        member.status === "invited" && { label: "Resend invitation", onSelect: () => run({ action: "resend", membershipId: member.membershipId }, "Invitation sent again.") },
        { separator: true },
        { label: member.status === "invited" ? "Revoke invitation" : "Remove from organisation", tone: "danger", onSelect: () => setStatus("removed", member.status === "invited" ? "invitation revoked" : "removed") },
      ]
    : [];

  const roleOptions = roles.filter((r) => !member.roles.some((a) => a.roleId === r.id && !a.siteId)).map((r) => ({ value: r.id, label: r.name, hint: r.description }));
  const deptOptions = departments.filter((d) => !(member.departments ?? []).some((m) => m.departmentId === d.id)).map((d) => ({ value: d.id, label: departmentLabel(d, sites) }));
  const seatOptions = seatItems.map((i) => ({ value: i.planSlug, label: i.planName, hint: `${i.available} free`, disabled: i.available < 1 && i.planSlug !== seat?.slug }));
  const busy = mutation.isPending || seatMutation.isPending;

  return (
    <li aria-label={name} className={`rounded-xl border border-border-color p-4 ${member.status === "removed" ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-start gap-3">
        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-theme/15 text-sm font-semibold text-primary-text">
          {initials(member)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-primary-text">
            {name} {isSelf && <span className="text-sm text-secondary-text">(you)</span>}
          </div>
          {member.email && member.email !== name && <div className="truncate text-sm text-secondary-text">{member.email}</div>}
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[member.status]}`}>{member.status}</span>
          {member.status === "invited" && member.invite && (
            <span className="text-xs text-secondary-text" aria-label={`Invitation to ${member.email}`}>
              {member.invite.expired ? "Expired" : member.invite.expiresAt ? `Expires in ${expiresIn(member.invite.expiresAt)}` : ""}
              {member.invite.packageName ? ` · ${member.invite.packageName} seat reserved` : ""}
              {member.invite.sendCount > 1 ? ` · sent ${member.invite.sendCount} times` : ""}
            </span>
          )}
        </div>
        <RowActionsMenu label={`Actions for ${name}`} items={actions} />
      </div>

      <div className={`mt-4 grid grid-cols-1 gap-4 ${seatsVisible ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
        <section aria-label={`Roles of ${name}`} className="flex flex-col gap-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-tertiary-text">Roles</h4>
          <ul className="flex flex-wrap gap-1.5" aria-label={`Role list of ${name}`}>
            {member.roles.map((r) => (
              <li key={r.assignmentId} className={chip}>
                {r.roleName}
                {r.siteId && <span className="text-secondary-text">@{siteName(r.siteId)}</span>}
                {editable && (
                  <button
                    type="button"
                    aria-label={`Remove role ${r.roleName} from ${name}`}
                    className="ml-0.5 cursor-pointer text-secondary-text hover:text-error-color"
                    disabled={busy}
                    onClick={() => run({ action: "unassign", assignmentId: r.assignmentId }, `${r.roleName} removed.`)}>
                    <XIcon />
                  </button>
                )}
              </li>
            ))}
            {member.roles.length === 0 && <li className="text-sm text-secondary-text">No roles</li>}
          </ul>
          {editable && roleOptions.length > 0 && (
            <ComboField
              label={`Add a role for ${name}`}
              value={null}
              onChange={(v) => v && run({ action: "assign", membershipId: member.membershipId, body: { roleId: v } }, "Role added.")}
              placeholder="Add a role…"
              disabled={busy}
              options={roleOptions}
              className="[&_label]:sr-only"
            />
          )}
        </section>

        <section aria-label={`Departments of ${name}`} className="flex flex-col gap-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-tertiary-text">Departments</h4>
          <ul className="flex flex-wrap gap-1.5" aria-label={`Department list of ${name}`}>
            {(member.departments ?? []).map((d) => (
              <li key={d.id} className={chip}>
                {d.name}
                <span className="text-secondary-text">@{d.siteName}</span>
                {d.isPrimary ? (
                  <span className="rounded-full bg-brand-primary/15 px-1.5 text-xs text-primary-text">primary</span>
                ) : (
                  editable && (
                    <button
                      type="button"
                      aria-label={`Make ${d.name} the primary department of ${name}`}
                      className="cursor-pointer text-xs text-secondary-text hover:text-primary-text"
                      disabled={busy}
                      onClick={() => run({ action: "setPrimaryDepartment", departmentMembershipId: d.id }, `${d.name} is now the primary department.`)}>
                      make primary
                    </button>
                  )
                )}
                {editable && (
                  <button
                    type="button"
                    aria-label={`Remove ${name} from ${d.name}`}
                    className="ml-0.5 cursor-pointer text-secondary-text hover:text-error-color"
                    disabled={busy}
                    onClick={() => run({ action: "endDepartment", departmentMembershipId: d.id }, `Removed from ${d.name}.`)}>
                    <XIcon />
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
          {editable && deptOptions.length > 0 && (
            <ComboField
              label={`Add a department for ${name}`}
              value={null}
              onChange={(v) => v && run({ action: "addDepartment", membershipId: member.membershipId, body: { departmentId: v } }, "Department added.")}
              placeholder="Add a department…"
              disabled={busy}
              options={deptOptions}
              className="[&_label]:sr-only"
            />
          )}
        </section>

        {seatsVisible && (
          <section aria-label={`Seat of ${name}`} className="flex flex-col gap-2">
            <h4 className="text-xs font-medium uppercase tracking-wide text-tertiary-text">Seat</h4>
            {canAssignSeats && member.status !== "removed" ? (
              <ComboField
                label={`Seat for ${name}`}
                value={seat?.slug ?? null}
                onChange={changeSeat}
                placeholder="No seat"
                clearable
                disabled={busy}
                options={seatOptions}
                className="[&_label]:sr-only"
              />
            ) : (
              <span className="text-sm text-primary-text">{seat?.name ?? <span className="text-secondary-text">No seat</span>}</span>
            )}
            <p className="text-xs text-secondary-text">The seat decides what the product offers them; roles decide what they may do.</p>
          </section>
        )}
      </div>
    </li>
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
  const seatsVisible = can("subscription.read");
  const canAssignSeats = can("subscription.seats");
  const seats = useSeatAssignments({ enabled: seatsVisible });
  const seatOverview = useSubscriptionOverview({ enabled: seatsVisible });
  const [showRemoved, setShowRemoved] = useState(false);
  const [search, setSearch] = useState("");
  const canManage = can("members.manage");

  if (members.isLoading || roles.isLoading) return <LoadingScreen />;
  if (members.error?.status === 403) {
    return <p className="p-4 text-secondary-text">You need the members.read permission to see this organisation's members.</p>;
  }
  if (members.error || roles.error) return <ApiUnavailable error={members.error ?? roles.error} />;

  const roleList = roles.data?.data ?? [];
  const siteList = sites.data?.data ?? [];
  const departmentList = departments.data?.data ?? [];
  const seatItems = seatOverview.data?.items ?? [];
  const seatOf = new Map((seats.data ?? []).map((s) => [s.membershipId, s.plan]));
  const all = members.data?.data ?? [];
  const unassigned = all.filter(isUnassigned);
  const term = search.trim().toLowerCase();
  const visible = all
    .filter((m) => showRemoved || m.status !== "removed")
    .filter((m) => !term || `${displayName(m)} ${m.email ?? ""}`.toLowerCase().includes(term));
  const counts = { active: all.filter((m) => m.status === "active").length, invited: all.filter((m) => m.status === "invited").length };

  return (
    <div className="flex w-full flex-col gap-5">
      <div>
        <h2 className="text-2xl font-semibold text-primary-text">Users &amp; permissions</h2>
        <p className="text-sm text-secondary-text">
          {canManage
            ? "Invite people, give them roles, departments and seats, and control their access. You can only grant roles whose permissions you hold yourself."
            : "Who has access to this organisation. An administrator can make changes."}
        </p>
      </div>

      {canManage && <InviteForm roles={roleList} sites={siteList} departments={departmentList} />}

      {unassigned.length > 0 && (
        <Callout tone="warning" role="status">
          {unassigned.length} {unassigned.length === 1 ? "person has" : "people have"} no department ({unassigned.map(displayName).join(", ")}). Alerts addressed to a
          department will not reach them until they are added to one.
        </Callout>
      )}

      <MenuCard
        aria-label="Members"
        title="Members"
        subtitle={`${counts.active} active${counts.invited ? ` · ${counts.invited} invited` : ""}`}
        action={
          <Switch className="text-sm text-secondary-text" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)}>
            Show removed
          </Switch>
        }
        bodyClassName="flex flex-col gap-3">
        <Field label="Search people" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or email" className="max-w-sm" />
        {visible.length === 0 ? (
          <p className="text-sm text-secondary-text">No one matches.</p>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Member list">
            {visible.map((m) => (
              <MemberCard
                key={m.membershipId}
                member={m}
                roles={roleList}
                sites={siteList}
                departments={departmentList}
                canManage={canManage}
                isSelf={m.userId === user?.id}
                seat={seatOf.get(m.membershipId) ?? null}
                seatItems={seatItems}
                seatsVisible={seatsVisible}
                canAssignSeats={canAssignSeats}
              />
            ))}
          </ul>
        )}
      </MenuCard>

      <MenuCard aria-label="Roles" title="Roles" subtitle="What each role can do" bodyClassName="flex flex-col gap-2">
        {roleList.map((r) => (
          <details key={r.id} className="text-primary-text">
            <summary className="cursor-pointer">
              <span className="font-medium">{r.name}</span> <span className="text-sm text-secondary-text">— {r.description}</span>
            </summary>
            <ul className="ml-5 mt-1 list-disc text-sm text-secondary-text">
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
