import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import MenuCard from "../ui/MenuCard";
import { describeApiError } from "../../lib/api-client";
import { ORGANISATION_WIDE_ROLE_KEYS } from "../../lib/departments";
import { expiresIn, parseEmails } from "../../lib/onboarding";
import { useToast } from "../../contexts/ToastProvider";
import { useAllDepartments, useMemberMutation, useMembers, usePermissions, useRoles, useSites } from "../../hooks/useQmsApi";
import { useSubscriptionOverview } from "../../hooks/useSubscription";
import CTAButton from "@/components/CTAButton";

const field =
  "rounded-lg border border-border-color bg-text-input-color px-2 min-h-9.5 py-1.5 text-sm text-primary-text disabled:opacity-60";
const PACKAGES = [
  { slug: "controller", label: "Controller" },
  { slug: "contributor", label: "Contributor" },
  { slug: "observer", label: "Observer" },
];

const emptyRow = (email) => ({ email, roleId: "", departmentIds: [], packageSlug: "" });
const departmentLabel = (d, sites) => `${sites.find((s) => s.id === d.siteId)?.code ?? ""} · ${d.name}`.replace(/^ · /, "");

/** What a result from the server says in one line. */
const outcomeText = (r) => {
  if (!r.ok) return r.error?.message ?? "Not invited";
  const e = r.emailOutcome;
  if (e?.sent) return e.kind === "sign_in_link" ? "Invited. They already have an account, so we emailed a sign-in link." : "Invited. An email is on its way.";
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
 * Invite several people at once: paste addresses, set the same role, departments and package for everyone (or per person), see the seats left
 * as you choose, send, and read what happened to each. Failed rows stay in the list so they can be fixed and sent again.
 */
const TeamInvite = () => {
  const { can } = usePermissions();
  const roles = useRoles();
  const sites = useSites();
  const departments = useAllDepartments();
  const mutation = useMemberMutation();
  const { showToast } = useToast();
  const [paste, setPaste] = useState("");
  const [rows, setRows] = useState([]);
  const [message, setMessage] = useState("");
  const [results, setResults] = useState(null);
  const seats = useSeats(rows);
  const canGivePackages = can("subscription.seats");

  const roleList = roles.data?.data ?? [];
  const siteList = sites.data?.data ?? [];
  const departmentList = departments.data?.data ?? [];
  const roleKey = (id) => roleList.find((r) => r.id === id)?.key;
  const needsDepartment = (row) => !!row.roleId && !ORGANISATION_WIDE_ROLE_KEYS.includes(roleKey(row.roleId));

  const update = (index, patch) => setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const applyToAll = (patch) => setRows((rs) => rs.map((r) => ({ ...r, ...patch })));
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
    });
    PACKAGES.forEach((p) => {
      if (seats.ready && seats.left(p.slug) < 0) list.push(`Not enough ${p.label} seats: ${-seats.left(p.slug)} more needed`);
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, roleList, seats.ready]);

  const send = () =>
    mutation.mutate(
      {
        action: "inviteMany",
        body: {
          invitations: rows.map((r) => ({
            email: r.email,
            roleId: r.roleId,
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
        <MenuCard title={`To invite (${rows.length})`} subtitle="Choose a role, departments and a package for each person, or use Set for everyone" bodyClassName="flex flex-col gap-3">
          <div className="grid gap-2 rounded-xl border border-border-color p-3 md:grid-cols-3" aria-label="Set for everyone" role="group">
            <label className="flex flex-col gap-1 text-xs text-secondary-text">
              Role for everyone
              <select className={field} value="" onChange={(e) => e.target.value && applyToAll({ roleId: e.target.value })}>
                <option value="">Set for everyone…</option>
                {roleList.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-secondary-text">
              Department for everyone
              <select className={field} value="" onChange={(e) => e.target.value && applyToAll({ departmentIds: [e.target.value] })}>
                <option value="">Set for everyone…</option>
                {departmentList.map((d) => <option key={d.id} value={d.id}>{departmentLabel(d, siteList)}</option>)}
              </select>
            </label>
            {canGivePackages && (
              <label className="flex flex-col gap-1 text-xs text-secondary-text">
                Package for everyone
                <select className={field} value="" onChange={(e) => applyToAll({ packageSlug: e.target.value === "none" ? "" : e.target.value })}>
                  <option value="">Set for everyone…</option>
                  <option value="none">No package</option>
                  {PACKAGES.map((p) => <option key={p.slug} value={p.slug}>{p.label}</option>)}
                </select>
              </label>
            )}
          </div>

          <ul className="flex flex-col gap-2">
            {rows.map((r, i) => (
              <li key={r.email} className="flex flex-col gap-2 rounded-xl border border-border-color p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-primary-text">{r.email}</span>
                  <button type="button" className="text-xs text-secondary-text underline" aria-label={`Remove ${r.email}`} onClick={() => setRows((rs) => rs.filter((_, x) => x !== i))}>Remove</button>
                </div>
                <div className="grid gap-2 md:grid-cols-3">
                  <label className="flex flex-col gap-1 text-xs text-secondary-text">
                    Role <span data-required className="sr-only">required</span>
                    <select aria-label={`Role for ${r.email}`} aria-required="true" className={field} value={r.roleId} onChange={(e) => update(i, { roleId: e.target.value })}>
                      <option value="">Choose a role</option>
                      {roleList.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                    </select>
                  </label>
                  <fieldset className="flex flex-col gap-1 text-xs text-secondary-text">
                    <legend data-required={needsDepartment(r) || undefined}>Departments</legend>
                    <div className="flex max-h-24 flex-col gap-1 overflow-y-auto rounded-lg border border-border-color p-2">
                      {departmentList.length === 0 && <span>No departments yet</span>}
                      {departmentList.map((d) => (
                        <label key={d.id} className="flex items-center gap-2 text-sm text-primary-text">
                          <input type="checkbox" checked={r.departmentIds.includes(d.id)} onChange={() => toggleDepartment(i, d.id)} aria-label={`${departmentLabel(d, siteList)} for ${r.email}`} />
                          {departmentLabel(d, siteList)}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {canGivePackages && (
                    <label className="flex flex-col gap-1 text-xs text-secondary-text">
                      Package
                      <select aria-label={`Package for ${r.email}`} className={field} value={r.packageSlug} onChange={(e) => update(i, { packageSlug: e.target.value })}>
                        <option value="">No package yet</option>
                        {PACKAGES.map((p) => (
                          <option key={p.slug} value={p.slug} disabled={seats.left(p.slug) < 1 && r.packageSlug !== p.slug}>
                            {p.label} ({Math.max(0, seats.left(p.slug) + (r.packageSlug === p.slug ? 1 : 0))} left)
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <label className="flex flex-col gap-1 text-sm text-primary-text">
            Message (optional, shown to everyone on the list)
            <textarea aria-label="Message" className={`${field} min-h-16`} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>

          {canGivePackages && seats.ready && (
            <div aria-label="Seats left" role="group" className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-primary-text">
              {PACKAGES.map((p) => (
                <span key={p.slug} className={seats.left(p.slug) < 0 ? "text-error-color" : ""}>
                  {p.label}: <strong>{seats.left(p.slug)}</strong> left of {seats.purchased(p.slug)}
                </span>
              ))}
              <Link to="/Settings/Subscription" className="text-link-color underline">Buy more seats</Link>
            </div>
          )}
          {!canGivePackages && <p className="text-xs text-secondary-text">You can invite people without a package; an owner or administrator can give them one afterwards.</p>}
          {problems.length > 0 && (
            <ul role="alert" className="list-disc pl-5 text-sm text-error-color">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
          <div className="flex justify-end">
            <CTAButton buttonType="button" type="main" size="lg" disabled={mutation.isPending || problems.length > 0} loading={mutation.isPending} onClick={send}>
              {mutation.isPending ? "Sending…" : `Send ${rows.length} invitation${rows.length === 1 ? "" : "s"}`}
            </CTAButton>
          </div>
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

      <PendingInvitations />
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
