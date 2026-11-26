import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import MenuCard from "../ui/MenuCard";
import { describeApiError } from "../../lib/api-client";
import { ORGANISATION_WIDE_ROLE_KEYS } from "../../lib/departments";
import { expiresIn, loadTeamDraft, parseEmails, saveTeamDraft, seatsForDraft } from "../../lib/onboarding";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useToast } from "../../contexts/ToastProvider";
import { useAllDepartments, useMemberMutation, useMembers, usePermissions, useRoles, useSites } from "../../hooks/useQmsApi";
import { useSubscriptionOverview } from "../../hooks/useSubscription";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import { XIcon } from "@/components/icons";

const field =
  "rounded-lg border border-border-color bg-text-input-color px-2 min-h-9.5 py-1.5 text-sm text-primary-text disabled:opacity-60";
const PACKAGES = [
  { slug: "controller", label: "Controller" },
  { slug: "contributor", label: "Contributor" },
  { slug: "observer", label: "Observer" },
];

/**
 * The roles that every organisation has. Before the plan is active the role list cannot be read (it needs rights that wait for the plan), so a draft
 * names roles from this list; each is matched to the organisation's real role when the invitations are sent.
 */
const FALLBACK_ROLES = [
  { id: "key:owner", key: "owner", name: "Owner" },
  { id: "key:admin", key: "admin", name: "Admin" },
  { id: "key:quality_manager", key: "quality_manager", name: "Quality manager" },
  { id: "key:quality_engineer", key: "quality_engineer", name: "Quality engineer" },
  { id: "key:inspector", key: "inspector", name: "Inspector" },
  { id: "key:viewer", key: "viewer", name: "Viewer" },
];

const emptyRow = (email) => ({ email, roleId: "", departmentIds: [], packageSlug: "" });
const departmentLabel = (d, sites) => `${sites.find((s) => s.id === d.siteId)?.code ?? ""} · ${d.name}`.replace(/^ · /, "");

/** What a result from the server says in one line. */
const outcomeText = (r) => {
  if (!r.ok) return r.error?.message ?? "Not invited";
  const e = r.emailOutcome;
  if (e?.sent && e.kind === "company_sign_in") return "Invited. We emailed them a link to sign in with their company account.";
  if (e?.sent) return e.kind === "sign_in_link" ? "Invited. They already have an account, so we emailed a sign-in link." : "Invited. An email is on its way.";
  if (e?.reason === "company_sign_in") return "Invited. They sign in with their company account: the invitation will be waiting when they do.";
  if (e?.reason === "not_configured") return "Invited. Email is not set up here, so tell them to sign in or sign up with this address.";
  if (e?.reason === "existing_account") return "Invited. They already have an account: they will see the invitation when they sign in.";
  return "Invited, but the email could not be sent. Use Resend below, or tell them to sign in.";
};

/** Seats left per package after what this list would take. */
const useSeats = (rows) => {
  const overview = useSubscriptionOverview();
  const items = overview.data?.items ?? [];
  const taken = (slug) => rows.filter((r) => r.packageSlug === slug).length;
  return {
    available: (slug) => items.find((i) => i.planSlug === slug)?.available ?? 0,
    left: (slug) => (items.find((i) => i.planSlug === slug)?.available ?? 0) - taken(slug),
    ready: !!overview.data,
    purchased: (slug) => items.find((i) => i.planSlug === slug)?.purchased ?? 0,
  };
};

/**
 * Invite several people at once: paste addresses, set the role, departments and package for each person, see the seats left
 * as you choose, send, and read what happened to each. Failed rows stay in the list so they can be fixed and sent again.
 */
const TeamInvite = ({ live = true }) => {
  const { can } = usePermissions();
  const { organisationId } = useOrganisation();
  // Until the plan is active the role list is out of reach: plan with the standard roles, and match them to the real ones when sending.
  const roles = useRoles({ enabled: live });
  const sites = useSites();
  const departments = useAllDepartments();
  const mutation = useMemberMutation();
  const { showToast } = useToast();
  const [paste, setPaste] = useState("");
  const [saved] = useState(() => loadTeamDraft(organisationId));
  const [rows, setRows] = useState(saved.rows);
  const [message, setMessage] = useState(saved.message);
  const [results, setResults] = useState(null);
  const seats = useSeats(rows);
  const canGivePackages = can("subscription.seats");
  // The plan is kept in this browser as it is typed, so leaving the page loses nothing.
  useEffect(() => saveTeamDraft(organisationId, { rows, message }), [organisationId, rows, message]);

  const roleList = live && roles.data?.data ? roles.data.data : FALLBACK_ROLES;
  const realRoleId = (id) => (id?.startsWith("key:") ? (roles.data?.data ?? []).find((r) => r.key === id.slice(4))?.id ?? "" : id);
  const siteList = sites.data?.data ?? [];
  const departmentList = departments.data?.data ?? [];
  // Once the real roles can be read, a planned person's standard role becomes the organisation's own.
  useEffect(() => {
    if (!live || !roles.data?.data) return;
    setRows((rs) => (rs.some((r) => r.roleId?.startsWith("key:")) ? rs.map((r) => (r.roleId?.startsWith("key:") ? { ...r, roleId: realRoleId(r.roleId) } : r)) : rs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, roles.data]);
  const roleKey = (id) => roleList.find((r) => r.id === id)?.key;
  const needsDepartment = (row) => !!row.roleId && !ORGANISATION_WIDE_ROLE_KEYS.includes(roleKey(row.roleId));
  const needed = seatsForDraft(rows);

  const update = (index, patch) => setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const toggleDepartment = (index, id) =>
    update(index, { departmentIds: rows[index].departmentIds.includes(id) ? rows[index].departmentIds.filter((x) => x !== id) : [...rows[index].departmentIds, id] });

  const add = () => {
    const emails = parseEmails(paste).filter((e) => !rows.some((r) => r.email === e));
    if (emails.length === 0) return;
    const template = rows[0] ?? emptyRow("");
    setRows((rs) => [...rs, ...emails.map((email) => ({ ...emptyRow(email), roleId: template.roleId, departmentIds: template.departmentIds, packageSlug: "" }))]);
    setPaste("");
    setResults(null);
  };

  const problems = useMemo(() => {
    const list = [];
    rows.forEach((r) => {
      if (!r.roleId) list.push(`${r.email}: choose a role`);
      else if (needsDepartment(r) && r.departmentIds.length === 0) list.push(`${r.email}: choose a department`);
      // Where packages are enforced a member with no seat cannot use anything, so every person is given one.
      else if (canGivePackages && !r.packageSlug) list.push(`${r.email}: choose a package`);
    });
    PACKAGES.forEach((p) => {
      if (live && seats.ready && seats.left(p.slug) < 0) list.push(`Not enough ${p.label} seats: ${-seats.left(p.slug)} more needed`);
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, roleList, seats.ready, live, canGivePackages]);

  const send = () =>
    mutation.mutate(
      {
        action: "inviteMany",
        body: {
          invitations: rows.map((r) => ({
            email: r.email,
            roleId: realRoleId(r.roleId),
            departmentIds: r.departmentIds,
            ...(r.packageSlug ? { packageSlug: r.packageSlug } : {}),
            ...(message.trim() ? { message: message.trim() } : {}),
          })),
        },
      },
      {
        onSuccess: (res) => {
          setResults(res.results);
          setRows((rs) => rs.filter((r) => !res.results.find((x) => x.email === r.email)?.ok));
          showToast({ type: res.failed ? "warning" : "success", title: res.invited ? `${res.invited} invited` : "Nobody was invited", message: res.failed ? `${res.failed} could not be invited. See below.` : "" });
        },
        onError: (e) => showToast({ type: "error", title: "Invitations not sent", message: describeApiError(e) }),
      },
    );

  return (
    <div className="flex flex-col gap-4">
      {!live && (
        <Callout tone="info" title="Plan your team now, invite them after you choose a plan">
          Add the people you will need and what each will do. We keep the list, use it to suggest how many seats to buy, and let you send the invitations once your plan is active.
        </Callout>
      )}
      {live && rows.length > 0 && !results && saved.rows.length > 0 && problems.length === 0 && (
        <Callout tone="success" title="Your planned team is ready to send">Review the list below, then send the invitations.</Callout>
      )}
      <MenuCard title="Add people" subtitle="Paste email addresses: one per line, or separated by commas" bodyClassName="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm text-primary-text">
          Email addresses
          <textarea aria-label="Email addresses" className={`${field} min-h-20`} value={paste} placeholder="ann@example.com, bob@example.com" onChange={(e) => setPaste(e.target.value)} />
        </label>
        <div className="flex justify-end">
          <CTAButton buttonType="button" type="neutral" size="md" disabled={parseEmails(paste).length === 0} onClick={add}>
            Add to the list
          </CTAButton>
        </div>
      </MenuCard>

      {rows.length > 0 && (
        <MenuCard title={`To invite (${rows.length})`} subtitle="Choose a role, departments and a package for each person" bodyClassName="flex flex-col gap-3">
          <ul className="flex flex-col gap-3 p-0">
            {rows.map((r, i) => {
              const chosen = departmentList.filter((d) => r.departmentIds.includes(d.id));
              const spare = departmentList.filter((d) => !r.departmentIds.includes(d.id));
              return (
                <li key={r.email} className="flex list-none flex-col gap-3 rounded-xl border border-border-color p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-medium text-primary-text">{r.email}</span>
                    <button type="button" className="text-xs text-secondary-text underline" aria-label={`Remove ${r.email}`} onClick={() => setRows((rs) => rs.filter((_, x) => x !== i))}>Remove</button>
                  </div>
                  <div className={`grid gap-3 ${canGivePackages ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
                    <div className="flex flex-col gap-1">
                      <span data-required className="text-xs text-secondary-text">Role</span>
                      <ComboField
                        ariaLabel={`Role for ${r.email}`}
                        value={r.roleId || null}
                        onChange={(id) => update(i, { roleId: id ?? "" })}
                        options={roleList.map((role) => ({ value: role.id, label: role.name }))}
                        required
                        placeholder="Choose a role"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span data-required={needsDepartment(r) || undefined} className="text-xs text-secondary-text">Departments</span>
                      <ComboField
                        ariaLabel={`Add a department for ${r.email}`}
                        value={null}
                        onChange={(id) => id && update(i, { departmentIds: [...r.departmentIds, id] })}
                        options={spare.map((d) => ({ value: d.id, label: departmentLabel(d, siteList) }))}
                        placeholder={departmentList.length === 0 ? "No departments yet" : spare.length === 0 ? "All added" : "Add a department"}
                        disabled={spare.length === 0}
                        clearable={false}
                      />
                      {chosen.length > 0 && (
                        <ul aria-label={`Departments for ${r.email}`} className="flex flex-wrap gap-1.5 p-0">
                          {chosen.map((d) => (
                            <li key={d.id} className="list-none">
                              <span className="inline-flex min-h-8 items-center gap-1 rounded-full border border-border-color bg-primary-bg pl-3 pr-1 text-sm text-primary-text">
                                {departmentLabel(d, siteList)}
                                <button type="button" aria-label={`Remove ${departmentLabel(d, siteList)} from ${r.email}`} className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-secondary-text hover:bg-secondary-bg hover:text-primary-text" onClick={() => toggleDepartment(i, d.id)}>
                                  <XIcon className="h-3.5 w-3.5" />
                                </button>
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {canGivePackages && (
                      <div className="flex flex-col gap-1">
                        <span data-required className="text-xs text-secondary-text">Package</span>
                        <ComboField
                          ariaLabel={`Package for ${r.email}`}
                          value={r.packageSlug || null}
                          onChange={(slug) => update(i, { packageSlug: slug ?? "" })}
                          options={PACKAGES.map((p) => ({
                            value: p.slug,
                            label: live ? `${p.label} (${Math.max(0, seats.left(p.slug) + (r.packageSlug === p.slug ? 1 : 0))} left)` : p.label,
                            disabled: live && seats.left(p.slug) < 1 && r.packageSlug !== p.slug,
                          }))}
                          placeholder="Choose a package"
                          required
                        />
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <label className="flex flex-col gap-1 text-sm text-primary-text">
            Message (optional, shown to everyone on the list)
            <textarea aria-label="Message" className={`${field} min-h-16`} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>

          {live && canGivePackages && seats.ready && (
            <div aria-label="Seats left" role="group" className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-primary-text">
              {PACKAGES.map((p) => (
                <span key={p.slug} className={seats.left(p.slug) < 0 ? "text-error-color" : ""}>
                  {p.label}: <strong>{seats.left(p.slug)}</strong> left of {seats.purchased(p.slug)}
                </span>
              ))}
              <Link to="/Settings/Subscription" className="text-link-color underline">Buy more seats</Link>
            </div>
          )}
          {!live && (
            <div aria-label="Seats this team needs" role="group" className="flex flex-wrap gap-x-4 gap-y-1 rounded-xl bg-primary-bg px-3 py-2 text-sm text-primary-text">
              <span className="text-secondary-text">Seats this team needs:</span>
              {PACKAGES.map((p) => (
                <span key={p.slug}>
                  {p.label}: <strong>{needed[p.slug]}</strong>
                  {p.slug === "controller" ? <span className="text-secondary-text"> (including you)</span> : null}
                </span>
              ))}
            </div>
          )}
          {!canGivePackages && <p className="text-xs text-secondary-text">You can invite people without a package; an owner or administrator can give them one afterwards. Until then they can sign in but not use Fortress.</p>}
          {problems.length > 0 && (
            <ul role="alert" className="list-disc pl-5 text-sm text-error-color">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
          {live ? (
            <div className="flex justify-end">
              <CTAButton buttonType="button" type="main" size="lg" disabled={mutation.isPending || problems.length > 0} loading={mutation.isPending} onClick={send}>
                {mutation.isPending ? "Sending…" : `Send ${rows.length} invitation${rows.length === 1 ? "" : "s"}`}
              </CTAButton>
            </div>
          ) : (
            <p className="text-xs text-secondary-text">Saved on this device as you go. Nobody is emailed until your plan is active.</p>
          )}
        </MenuCard>
      )}

      {results && (
        <MenuCard title="What happened" subtitle="People who could not be invited stay in the list above so you can fix and send again">
          <ul aria-label="Results" className="flex flex-col gap-1 text-sm">
            {results.map((r) => (
              <li key={r.email} className={r.ok ? "text-primary-text" : "text-error-color"}>
                <strong>{r.email}</strong>: {outcomeText(r)}
              </li>
            ))}
          </ul>
        </MenuCard>
      )}

      {live && <PendingInvitations />}
    </div>
  );
};

/** Invitations waiting for an answer, with when they expire and Resend / Revoke. */
export const PendingInvitations = () => {
  const members = useMembers();
  const mutation = useMemberMutation();
  const { can } = usePermissions();
  const { showToast } = useToast();
  const pending = (members.data?.data ?? []).filter((m) => m.status === "invited");
  if (pending.length === 0) return null;
  const run = (vars, ok) =>
    mutation.mutate(vars, {
      onSuccess: (res) => showToast({ type: "success", title: ok, message: res?.email && !res.email.sent ? "The email could not be sent; tell them to sign in." : "" }),
      onError: (e) => showToast({ type: "error", title: "Not changed", message: describeApiError(e) }),
    });
  return (
    <MenuCard title={`Waiting for an answer (${pending.length})`} subtitle="Invitations last 14 days. Resending gives them 14 more.">
      <ul aria-label="Pending invitations" className="flex flex-col gap-2">
        {pending.map((m) => (
          <li key={m.membershipId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-color p-3 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium text-primary-text">{m.email}</div>
              <div className="text-xs text-secondary-text">
                {m.roles.map((r) => r.roleName).join(", ") || "No role"}
                {m.invite?.packageName ? ` · ${m.invite.packageName} seat reserved` : ""}
                {m.invite?.expired ? " · expired" : m.invite?.expiresAt ? ` · expires in ${expiresIn(m.invite.expiresAt)}` : ""}
                {m.invite?.sendCount > 1 ? ` · sent ${m.invite.sendCount} times` : ""}
              </div>
            </div>
            {can("members.manage") && (
              <div className="flex gap-2">
                <CTAButton buttonType="button" type="neutral" size="md" disabled={mutation.isPending} loading={mutation.isPending} aria-label={`Resend to ${m.email}`} onClick={() => run({ action: "resend", membershipId: m.membershipId }, "Invitation sent again")}>
                  Resend
                </CTAButton>
                <CTAButton buttonType="button" type="neutral" size="md" disabled={mutation.isPending} loading={mutation.isPending} aria-label={`Revoke ${m.email}`} onClick={() => run({ action: "revoke", membershipId: m.membershipId }, "Invitation revoked")}>
                  Revoke
                </CTAButton>
              </div>
            )}
          </li>
        ))}
      </ul>
    </MenuCard>
  );
};

export default TeamInvite;
