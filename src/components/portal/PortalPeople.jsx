import { useState } from "react";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RowActionsMenu from "../ui/RowActionsMenu";
import CTAButton from "@/components/CTAButton";
import { TextAreaField } from "../master-data/shared";
import { PlusIcon } from "@/components/icons";
import { usePortalMutation, usePortalPeople } from "../../hooks/usePortal";
import { describeApiError } from "../../lib/api-client";
import { ROLE_LABEL, accessStatus, lastSeenWords, personLine } from "../../lib/portal";

/** A party admin's own colleagues: invite, send again, remove (with a reason). Only their own company, never the organisation's staff or other suppliers. */
export default function PortalPeople({ access }) {
  const people = usePortalPeople(access.organisationId);
  const mutate = usePortalMutation(access.organisationId);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [reason, setReason] = useState("");
  const rows = (people.data?.data ?? []).filter((p) => p.status !== "removed");

  const invite = (e) => {
    e.preventDefault();
    setNotice(null);
    mutate.mutate(
      { action: "invite", body: { email, message: message || undefined } },
      {
        onSuccess: (res) => {
          setEmail("");
          setMessage("");
          setNotice({ tone: res.email?.sent ? "success" : "info", text: res.email?.sent ? `An invitation has been emailed to ${res.person.email}.` : `Invitation saved for ${res.person.email}. They will see it when they sign in with that address.` });
        },
        onError: (error) => setNotice({ tone: "error", text: describeApiError(error) }),
      },
    );
  };

  return (
    <section aria-labelledby="portal-people" className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-5">
      <div>
        <h2 id="portal-people" className="text-lg font-semibold">People at {access.partyName}</h2>
        <p className="text-sm text-secondary-text">As an admin you can invite your colleagues and remove people who have left.</p>
      </div>
      <ul className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color" aria-label={`People at ${access.partyName}`}>
        {rows.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
            <div className="min-w-0 grow">
              <p className="truncate">{personLine(p)}</p>
              <p className="text-xs text-secondary-text">{ROLE_LABEL[p.role]} · {accessStatus(p.status).label} · last sign-in: {lastSeenWords(p.lastSignInAt)}</p>
            </div>
            <RowActionsMenu
              label={`Actions for ${p.email}`}
              items={[
                p.status === "invited" && { label: "Send invitation again", onSelect: () => mutate.mutate({ action: "resend", id: p.id }, { onError: (e) => setNotice({ tone: "error", text: describeApiError(e) }) }) },
                p.role !== "admin" && { label: p.status === "invited" ? "Withdraw invitation" : "Remove", tone: "danger", onSelect: () => { setReason(""); setRemoving(p); } },
              ]}
            />
          </li>
        ))}
      </ul>
      <form onSubmit={invite} className="flex flex-col gap-3" noValidate aria-label="Invite a colleague">
        <Field label="Invite a colleague" required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@yourcompany.com" autoComplete="off" />
        <TextAreaField label="Message (optional)" rows={2} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} />
        <div className="flex justify-end">
          <CTAButton type="main" size="md" buttonType="submit" icon={PlusIcon} disabled={!email.trim()} loading={mutate.isPending && mutate.variables?.action === "invite"}>
            Send invitation
          </CTAButton>
        </div>
      </form>
      {notice && <Callout tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</Callout>}
      {removing && (
        <Dialog title={`Remove ${removing.email}`} onClose={() => setRemoving(null)}>
          <form
            className="flex flex-col gap-3"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              mutate.mutate({ action: "remove", id: removing.id, body: { reason } }, { onSuccess: () => setRemoving(null), onError: (er) => setNotice({ tone: "error", text: describeApiError(er) }) });
            }}>
            <p className="text-sm text-secondary-text">Their access ends at once. What they wrote stays on the records under their name.</p>
            <TextAreaField label="Reason" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="flex justify-end gap-2">
              <CTAButton type="neutral" size="md" onClick={() => setRemoving(null)}>Cancel</CTAButton>
              <CTAButton type="danger" size="md" buttonType="submit" disabled={reason.trim().length < 3} loading={mutate.isPending}>Remove</CTAButton>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
