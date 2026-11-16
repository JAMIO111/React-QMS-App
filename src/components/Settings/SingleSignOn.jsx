import { useState } from "react";
import MenuCard from "../ui/MenuCard";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import CopyButton from "../ui/CopyButton";
import RowActionsMenu from "../ui/RowActionsMenu";
import CTAButton from "@/components/CTAButton";
import { TextAreaField } from "../master-data/shared";
import { PlusIcon, RefreshCwIcon } from "@/components/icons";
import { useSso, useSsoMutation } from "../../hooks/useSecurity";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { SSO_DOMAIN_STATES, normaliseDomain, ssoCheckWords, whenWords } from "../../lib/security";

const Pill = ({ tone, children }) => {
  const cls = {
    success: "bg-success-color/15 text-success-color",
    warning: "bg-warning-color/15 text-warning-color",
    error: "bg-error-color/15 text-error-color",
    neutral: "bg-secondary-bg text-secondary-text",
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
};

/**
 * Settings → Security → Single sign-on (docs/sso-plan.md SS1): the email domains the organisation proves it owns with a DNS TXT record. Proving a
 * domain is the first step: a domain linked to single sign-on sends everyone at it to the company's own sign-in, so another company must never
 * be able to claim it. The sign-in provider and the Off / Optional / Required choice come in the next slices.
 */
export default function SingleSignOn({ canManage }) {
  const sso = useSso();
  const mutate = useSsoMutation();
  const { showToast } = useToast();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const s = sso.data;
  if (sso.isError) return <Callout tone="error" title="Single sign-on">{describeApiError(sso.error)}</Callout>;
  if (!s) return null;
  const live = s.domains.filter((d) => d.state !== "removed");
  const removed = s.domains.filter((d) => d.state === "removed");

  const add = (e) => {
    e.preventDefault();
    setProblem(null);
    const d = normaliseDomain(text);
    if (!d) return setProblem("Type a domain such as acme.com.");
    mutate.mutate({ action: "addDomain", body: { domain: d } }, { onSuccess: () => setText(""), onError: (error) => setProblem(describeApiError(error)) });
  };
  const check = (domain) =>
    mutate.mutate(
      { action: "verifyDomain", id: domain.id },
      {
        onSuccess: (data) => showToast(ssoCheckWords(data?.check?.outcome, domain.domain)),
        onError: (error) => showToast({ type: "error", title: "Not checked", message: describeApiError(error) }),
      },
    );
  const checking = (id) => mutate.isPending && mutate.variables?.action === "verifyDomain" && mutate.variables?.id === id;

  return (
    <MenuCard
      title="Single sign-on"
      subtitle="Let people sign in with their company account (Microsoft, Okta, Google and others). First, prove which email domains are yours."
      bodyClassName="flex flex-col gap-4">
      <p className="text-sm text-secondary-text">
        For each domain, add the TXT record shown at the company that runs the domain&apos;s DNS, then choose <strong>Check now</strong>. Once a domain is
        verified it is yours in Fortress: no other organisation can use it. Connecting your sign-in provider comes next.
      </p>

      {live.length === 0 ? (
        <p className="text-sm text-secondary-text">No domains yet.</p>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Single sign-on domains">
          {live.map((d) => (
            <DomainRow key={d.id} domain={d} canManage={canManage} checking={checking(d.id)} onCheck={() => check(d)} onRemove={() => setRemoving(d)} />
          ))}
        </ul>
      )}

      {canManage && (
        <form noValidate onSubmit={add} className="flex flex-wrap items-end gap-2">
          <Field label="Add a domain" value={text} onChange={(e) => setText(e.target.value)} placeholder="acme.com" className="min-w-56 flex-1" />
          <CTAButton type="neutral" size="default" buttonType="submit" icon={PlusIcon} loading={mutate.isPending && mutate.variables?.action === "addDomain"}>
            Add
          </CTAButton>
        </form>
      )}
      {problem && <Callout tone="error" role="alert">{problem}</Callout>}
      {s.allowedEmailDomains.length > 0 && (
        <p className="text-xs text-secondary-text">Only domains people may be invited from can be added: {s.allowedEmailDomains.map((d) => `@${d}`).join(", ")}.</p>
      )}

      {removed.length > 0 && (
        <div className="flex flex-col gap-2">
          <button type="button" className="self-start text-sm text-secondary-text underline cursor-pointer" onClick={() => setShowRemoved((v) => !v)} aria-expanded={showRemoved}>
            {showRemoved ? "Hide" : "Show"} removed domains ({removed.length})
          </button>
          {showRemoved && (
            <ul className="flex flex-col gap-1 text-sm text-secondary-text" aria-label="Removed domains">
              {removed.map((d) => (
                <li key={d.id}>
                  {d.domain}: removed {d.removedAt ? whenWords(d.removedAt) : ""}{d.removedBy ? ` by ${d.removedBy}` : ""}. {d.removedReason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {removing && <RemoveDomainDialog domain={removing} onClose={() => setRemoving(null)} />}
    </MenuCard>
  );
}

function DomainRow({ domain: d, canManage, checking, onCheck, onRemove }) {
  const state = SSO_DOMAIN_STATES[d.state];
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border-color p-3" aria-label={d.domain}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-primary-text">{d.domain}</span>
        <Pill tone={state.tone}>{state.label}</Pill>
        <span className="ml-auto flex items-center gap-2">
          {canManage && (
            <CTAButton type={d.state === "verified" ? "neutral" : "secondary"} size="default" icon={RefreshCwIcon} onClick={onCheck} loading={checking} loadingText="Checking">
              Check now
            </CTAButton>
          )}
          {canManage && <RowActionsMenu label={`Actions for ${d.domain}`} items={[{ label: "Remove…", tone: "danger", onSelect: onRemove }]} />}
        </span>
      </div>
      {d.state === "verified" && (
        <p className="text-sm text-secondary-text">
          Verified {whenWords(d.verifiedAt)}{d.verifiedBy ? ` by ${d.verifiedBy}` : ""}. Keep the record in place: Fortress checks it every week.
        </p>
      )}
      {d.state === "failing" && (
        <Callout tone="error" title="The record has gone">
          {d.checkError} The domain stays verified for now; put the record back and choose Check now.
        </Callout>
      )}
      {d.state === "unverified" && d.checkError && <p className="text-sm text-warning-color">{d.checkError}</p>}
      {d.record && d.state !== "verified" && (
        <dl className="grid gap-2 rounded-lg bg-secondary-bg p-3 text-sm sm:grid-cols-[auto_1fr_auto] sm:items-center">
          <dt className="text-secondary-text">Type</dt>
          <dd className="font-mono sm:col-span-2">{d.record.type}</dd>
          <dt className="text-secondary-text">Name</dt>
          <dd className="font-mono break-all">{d.record.name}</dd>
          <dd><CopyButton text={d.record.name} label={`Copy the record name for ${d.domain}`} /></dd>
          <dt className="text-secondary-text">Value</dt>
          <dd className="font-mono break-all">{d.record.value}</dd>
          <dd><CopyButton text={d.record.value} label={`Copy the record value for ${d.domain}`} /></dd>
        </dl>
      )}
    </li>
  );
}

function RemoveDomainDialog({ domain, onClose }) {
  const mutate = useSsoMutation();
  const { showToast } = useToast();
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState(null);
  const submit = (e) => {
    e.preventDefault();
    if (reason.trim().length < 3) return setProblem("Say why it is being removed.");
    onClose();
    mutate.mutate(
      { action: "removeDomain", id: domain.id, body: { reason: reason.trim() } },
      { onError: (error) => showToast({ type: "error", title: "Not removed", message: describeApiError(error) }) },
    );
  };
  return (
    <Dialog title={`Remove ${domain.domain}?`} onClose={onClose}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">
          {domain.state === "verified" ? "It stops being verified, and another organisation could then prove it. " : ""}It is kept in the history; you can add it again later.
        </p>
        <TextAreaField label="Why?" required value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        {problem && <Callout tone="error" role="alert">{problem}</Callout>}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton type="danger" size="md" buttonType="submit">Remove</CTAButton>
        </div>
      </form>
    </Dialog>
  );
}
