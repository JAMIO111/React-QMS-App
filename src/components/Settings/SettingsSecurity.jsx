import { useState } from "react";
import MenuCard from "../ui/MenuCard";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import SlidingToggle from "../ui/SlidingToggle";
import RowActionsMenu from "../ui/RowActionsMenu";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";
import { TextAreaField } from "../master-data/shared";
import RequireMfaSetting from "./RequireMfaSetting";
import { PlusIcon, ShieldCheckIcon } from "@/components/icons";
import { useOrganisationDetails, usePermissions } from "../../hooks/useQmsApi";
import { useAccessDenials, useAccessPolicy, useSecurityMutation } from "../../hooks/useSecurity";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { MODES, ENFORCE_WORD, denialWords, enforceProblems, modeLabel, whenWords } from "../../lib/security";

/**
 * Settings → Security (docs/security-plan.md SE4): two-factor (moved here from Organisation), access restrictions (the network policy and the
 * approved networks) and recent blocked attempts. Owners and admins only (security.read / security.manage); the server applies every rule
 * again, including the one that refuses a change that would block the person making it.
 */
const SettingsSecurity = () => {
  const { can, isLoading } = usePermissions();
  const org = useOrganisationDetails();
  if (isLoading) return <LoadingScreen />;
  if (!can("security.read")) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Callout tone="info" title="Security settings">
          Only the organisation&apos;s owners and administrators can see these settings.
        </Callout>
      </div>
    );
  }
  const canManage = can("security.manage");
  return (
    <div className="flex flex-col gap-4">
      <RequireMfaSetting value={!!org.data?.settings?.requireMfa} canManage={canManage && can("organisation.manage")} />
      <AccessRestrictions canManage={canManage} />
      <BlockedAttempts canManage={canManage} />
    </div>
  );
};

export default SettingsSecurity;

const Pill = ({ tone, children }) => {
  const cls = {
    success: "bg-success-color/15 text-success-color",
    warning: "bg-warning-color/15 text-warning-color",
    error: "bg-error-color/15 text-error-color",
    neutral: "bg-secondary-bg text-secondary-text",
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
};

function AccessRestrictions({ canManage }) {
  const policy = useAccessPolicy();
  const monitored = useAccessDenials({ mode: "monitor" });
  const mutate = useSecurityMutation();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null); // { kind: 'network', network?, prefill? } | { kind: 'remove', network } | { kind: 'enforce' }
  const [showRemoved, setShowRemoved] = useState(false);

  if (policy.isLoading) return <MenuCard title="Access restrictions"><LoadingScreen /></MenuCard>;
  if (policy.error) {
    return (
      <MenuCard title="Access restrictions">
        <Callout tone="error">{describeApiError(policy.error)}</Callout>
      </MenuCard>
    );
  }
  const p = policy.data;
  const live = p.networks.filter((n) => !n.removed);
  const removed = p.networks.filter((n) => n.removed);
  const fail = (title) => (error) => showToast({ type: "error", title, message: describeApiError(error) });

  const chooseMode = (mode) => {
    if (mode === p.mode) return;
    if (mode === "enforce") return setDialog({ kind: "enforce" });
    mutate.mutate({ action: "setMode", body: { mode } }, { onError: fail("Not changed") });
  };
  const toggleNetwork = (n) =>
    mutate.mutate({ action: "updateNetwork", id: n.id, body: { active: !n.active } }, { onError: fail("Not changed") });

  return (
    <MenuCard
      title="Access restrictions"
      subtitle="Allow this organisation to be used only from approved networks, such as your offices, factories and company VPN."
      bodyClassName="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <SlidingToggle
          ariaLabel="Network policy"
          mode="radio"
          value={p.mode}
          onChange={chooseMode}
          options={MODES.map((m) => ({ value: m.value, label: m.label, disabled: !canManage && m.value !== p.mode }))}
        />
        <p className="text-sm text-secondary-text">{MODES.find((m) => m.value === p.mode)?.description}</p>
        {p.changedAt && (
          <p className="text-xs text-secondary-text">
            Last changed {whenWords(p.changedAt)}{p.changedBy ? ` by ${p.changedBy}` : ""}.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border-color bg-secondary-bg px-4 py-3">
        <ShieldCheckIcon className="text-lg text-secondary-text" aria-hidden />
        <p className="text-sm text-primary-text">
          Your address as Fortress sees it: <span className="font-mono font-medium">{p.address ?? "unknown"}</span>
        </p>
        {p.address && (p.covered ? <Pill tone="success">In an approved network</Pill> : <Pill tone="warning">Not in an approved network</Pill>)}
        {canManage && p.address && !p.covered && (
          <CTAButton type="neutral" size="default" icon={PlusIcon} className="ml-auto" onClick={() => setDialog({ kind: "network", prefill: { network: p.address } })}>
            Add this address
          </CTAButton>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-primary-text">Approved networks</h3>
          {canManage && (
            <CTAButton type="main" size="default" icon={PlusIcon} onClick={() => setDialog({ kind: "network" })}>
              Add network
            </CTAButton>
          )}
        </div>
        {live.length === 0 ? (
          <p className="text-sm text-secondary-text">No networks yet. Add your office&apos;s public address or range (your IT team or internet provider can tell you it).</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color" aria-label="Approved networks">
            {live.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium text-primary-text">{n.name}</span>
                  <span className="text-sm text-secondary-text">
                    <span className="font-mono">{n.network}</span> · {n.count}
                    {n.updatedBy ? ` · changed ${whenWords(n.updatedAt)} by ${n.updatedBy}` : ""}
                  </span>
                </div>
                {n.includesYou && <Pill tone="success">Includes you</Pill>}
                <button
                  type="button"
                  role="switch"
                  aria-checked={n.active}
                  aria-label={`${n.name} active`}
                  disabled={!canManage}
                  onClick={() => toggleNetwork(n)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${n.active ? "bg-brand-primary" : "bg-border-dark-color"} ${canManage ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}>
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${n.active ? "left-5.5" : "left-0.5"}`} />
                </button>
                {canManage && (
                  <RowActionsMenu
                    label={`Actions for ${n.name}`}
                    items={[
                      { label: "Edit", onSelect: () => setDialog({ kind: "network", network: n }) },
                      { label: "Remove", tone: "danger", onSelect: () => setDialog({ kind: "remove", network: n }) },
                    ]}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {removed.length > 0 && (
          <div className="flex flex-col gap-2">
            <button type="button" className="self-start text-sm text-link-color hover:underline cursor-pointer" onClick={() => setShowRemoved((v) => !v)} aria-expanded={showRemoved}>
              {showRemoved ? "Hide" : "Show"} removed networks ({removed.length})
            </button>
            {showRemoved && (
              <ul className="flex flex-col gap-2" aria-label="Removed networks">
                {removed.map((n) => (
                  <li key={n.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border-color px-4 py-2 text-sm text-secondary-text">
                    <span className="flex-1">
                      <span className="font-medium text-primary-text">{n.name}</span> <span className="font-mono">{n.network}</span> — removed {whenWords(n.removedAt)}
                      {n.removedBy ? ` by ${n.removedBy}` : ""}: {n.removedReason}
                    </span>
                    {canManage && (
                      <CTAButton type="neutral" size="default" loading={mutate.isPending && mutate.variables?.id === n.id}
                        onClick={() => mutate.mutate({ action: "restoreNetwork", id: n.id }, { onSuccess: () => showToast({ type: "success", title: "Brought back", message: `${n.name} is back, switched off.` }), onError: fail("Not brought back") })}>
                        Bring back
                      </CTAButton>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {(p.history ?? []).length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-base font-semibold text-primary-text">Changes</h3>
          <ul className="flex flex-col gap-2" aria-label="Changes to network restrictions">
            {p.history.map((h) => (
              <li key={h.id} className={`rounded-lg border px-4 py-2 text-sm ${h.kind === "recovery" ? "border-warning-color" : "border-border-color"}`}>
                <span className="text-primary-text">
                  {modeLabel(h.from)} → {modeLabel(h.to)}
                  {h.by ? ` by ${h.by}` : ""}
                </span>
                <span className="text-secondary-text"> · {whenWords(h.at)}</span>
                {h.kind === "recovery" && (
                  <p className="mt-1 text-secondary-text">
                    Access recovered because nobody could get in: {h.reason} (checked by: {h.verification})
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {dialog?.kind === "network" && <NetworkDialog network={dialog.network} prefill={dialog.prefill} onClose={() => setDialog(null)} />}
      {dialog?.kind === "remove" && <RemoveDialog network={dialog.network} onClose={() => setDialog(null)} />}
      {dialog?.kind === "enforce" && <EnforceDialog policy={p} monitored={monitored.data?.data ?? []} onClose={() => setDialog(null)} />}
    </MenuCard>
  );
}

export function NetworkDialog({ network, prefill, onClose }) {
  const mutate = useSecurityMutation();
  const { showToast } = useToast();
  const [name, setName] = useState(network?.name ?? prefill?.name ?? "");
  const [value, setValue] = useState(network?.network ?? prefill?.network ?? "");
  const [problem, setProblem] = useState(null);
  const submit = (e) => {
    e.preventDefault();
    setProblem(null);
    if (!name.trim() || !value.trim()) return setProblem("Give the network a name and an address or range.");
    const vars = network
      ? { action: "updateNetwork", id: network.id, body: { name: name.trim(), network: value.trim() } }
      : { action: "addNetwork", body: { name: name.trim(), network: value.trim() } };
    mutate.mutate(vars, {
      onSuccess: () => {
        showToast({ type: "success", title: "Saved", message: network ? `${name.trim()} updated.` : `${name.trim()} approved.` });
        onClose();
      },
      onError: (error) => setProblem(describeApiError(error)),
    });
  };
  return (
    <Dialog title={network ? `Edit ${network.name}` : "Add network"} onClose={onClose}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name" required value={name} maxLength={200} onChange={(e) => setName(e.target.value)} hint="For example Head office, Factory 2 or Company VPN." />
        <Field
          label="Address or range"
          required
          value={value}
          maxLength={100}
          onChange={(e) => setValue(e.target.value)}
          inputClassName="font-mono"
          hint="One public address (203.0.113.10) or a range (203.0.113.0/28, 2001:db8:1234::/48). Ask your IT team or internet provider."
        />
        {problem && <Callout tone="error" role="alert">{problem}</Callout>}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton type="main" size="md" buttonType="submit" loading={mutate.isPending}>{network ? "Save" : "Add network"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
}

function RemoveDialog({ network, onClose }) {
  const mutate = useSecurityMutation();
  const { showToast } = useToast();
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState(null);
  const submit = (e) => {
    e.preventDefault();
    if (reason.trim().length < 3) return setProblem("Say why it is being removed.");
    mutate.mutate(
      { action: "removeNetwork", id: network.id, body: { reason: reason.trim() } },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Removed", message: `${network.name} is no longer approved.` });
          onClose();
        },
        onError: (error) => setProblem(describeApiError(error)),
      },
    );
  };
  return (
    <Dialog title={`Remove ${network.name}?`} onClose={onClose}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">
          <span className="font-mono">{network.network}</span> stops being an approved network. It is kept in the history and can be brought back.
        </p>
        <TextAreaField label="Why?" required value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        {problem && <Callout tone="error" role="alert">{problem}</Callout>}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton type="danger" size="md" buttonType="submit" loading={mutate.isPending}>Remove</CTAButton>
        </div>
      </form>
    </Dialog>
  );
}

function EnforceDialog({ policy, monitored, onClose }) {
  const mutate = useSecurityMutation();
  const { showToast } = useToast();
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState(null);
  const problems = enforceProblems(policy);
  const outside = monitored.filter((d) => !d.nowAllowed);
  const people = new Set(outside.map((d) => d.person?.id ?? d.address)).size;
  const ready = problems.length === 0 && typed.trim().toLowerCase() === ENFORCE_WORD;
  const submit = (e) => {
    e.preventDefault();
    if (!ready) return;
    mutate.mutate(
      { action: "setMode", body: { mode: "enforce", confirm: true } },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Enforced", message: "Only approved networks can use this organisation now." });
          onClose();
        },
        onError: (error) => setProblem(describeApiError(error)),
      },
    );
  };
  return (
    <Dialog title="Enforce access restrictions?" onClose={onClose} width="max-w-xl">
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-primary-text">
          From now on, anyone outside the approved networks is blocked from this organisation: on mobile data, at home (unless they connect through
          the company VPN), at a supplier or a customer. Emails about this organisation will only say that there is something new.
        </p>
        <ul className="list-disc pl-5 text-sm text-secondary-text">
          <li>{policy.activeCount} approved network{policy.activeCount === 1 ? "" : "s"} switched on.</li>
          <li>Your address {policy.address ?? "(unknown)"} is {policy.covered ? "inside one" : "not inside any"}.</li>
          <li>
            {outside.length === 0
              ? "Nobody was recorded outside the approved networks while monitoring."
              : `While monitoring, ${people} ${people === 1 ? "person or address was" : "people or addresses were"} outside the approved networks (see Recent blocked attempts). They will be blocked.`}
          </li>
        </ul>
        {problems.length > 0 && (
          <Callout tone="warning" title="Not yet">
            <ul className="list-disc pl-5">{problems.map((x) => <li key={x}>{x}</li>)}</ul>
          </Callout>
        )}
        <Field label={`Type "${ENFORCE_WORD}" to confirm`} required value={typed} onChange={(e) => setTyped(e.target.value)} disabled={problems.length > 0} autoComplete="off" />
        {problem && <Callout tone="error" role="alert">{problem}</Callout>}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton type="danger" size="md" buttonType="submit" disabled={!ready} loading={mutate.isPending}>Enforce</CTAButton>
        </div>
      </form>
    </Dialog>
  );
}

function BlockedAttempts({ canManage }) {
  const denials = useAccessDenials();
  const [prefill, setPrefill] = useState(null);
  const rows = denials.data?.data ?? [];
  return (
    <MenuCard title="Recent blocked attempts" subtitle="Requests from outside the approved networks: blocked while enforced, recorded only while monitoring. Kept for 90 days.">
      {denials.isLoading ? (
        <LoadingScreen />
      ) : denials.error ? (
        <Callout tone="error">{describeApiError(denials.error)}</Callout>
      ) : rows.length === 0 ? (
        <p className="text-sm text-secondary-text">None recorded.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-color" aria-label="Recent blocked attempts">
          {rows.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="min-w-0 flex-1 text-sm text-primary-text">{denialWords(d)}</span>
              <Pill tone={d.mode === "enforce" ? "error" : "warning"}>{d.mode === "enforce" ? "Blocked" : "Would be blocked"}</Pill>
              {d.nowAllowed && <Pill tone="success">Now allowed</Pill>}
              {canManage && !d.nowAllowed && d.address !== "unknown" && (
                <CTAButton type="neutral" size="default" icon={PlusIcon} onClick={() => setPrefill({ network: d.address, name: d.person?.name ? `${d.person.name}'s network` : "" })}>
                  Add this address
                </CTAButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {prefill && <NetworkDialog prefill={prefill} onClose={() => setPrefill(null)} />}
    </MenuCard>
  );
}
