import { useEffect, useState } from "react";
import { usePlatformOrganisations, useRecoverNetworkPolicy } from "../../hooks/usePlatform";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import Callout from "../ui/Callout";
import { TextAreaField } from "../master-data/shared";
import { describeApiError } from "../../lib/api-client";
import { Card, Panel, Pill, Table } from "./Panels";
import { day, pounds, statusTone } from "./format";
import CTAButton from "@/components/CTAButton";

const PAGE = 25;

const Subscription = ({ o }) => {
  if (!o.subscriptionStatus) return <span className="text-secondary-text">{o.billingRequired ? "None yet" : "Not required"}</span>;
  const end = o.subscriptionStatus === "trialing" ? `trial ends ${day(o.trialEnd)}` : o.cancelAtPeriodEnd ? `ends ${day(o.currentPeriodEnd)}` : o.currentPeriodEnd ? `renews ${day(o.currentPeriodEnd)}` : "";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        <Pill tone={statusTone(o.subscriptionStatus)}>{o.subscriptionStatus.replace("_", " ")}</Pill>
        <span className="text-xs text-secondary-text">{o.billingProvider === "stripe" ? "Stripe" : "manual"}{o.billingInterval ? `, ${o.billingInterval === "year" ? "annual" : "monthly"}` : ""}</span>
      </span>
      {end ? <span className="text-xs text-secondary-text">{end}</span> : null}
    </div>
  );
};

/**
 * Recover access (security plan SE5): an organisation whose network restrictions lock everyone out goes back to monitor (never off). The operator
 * says why and how they checked the request came from an owner; owners and admins are told, and it is in their history.
 */
export const RecoverAccessDialog = ({ organisation, onClose }) => {
  const recover = useRecoverNetworkPolicy();
  const [reason, setReason] = useState("");
  const [verification, setVerification] = useState("");
  const [problem, setProblem] = useState(null);
  const [done, setDone] = useState(false);
  const submit = (e) => {
    e.preventDefault();
    setProblem(null);
    if (reason.trim().length < 10) return setProblem("Say why access is being recovered (at least 10 characters).");
    if (verification.trim().length < 10) return setProblem("Say how you checked the request came from an owner (at least 10 characters).");
    recover.mutate({ organisationId: organisation.organisationId, reason: reason.trim(), verification: verification.trim() }, {
      onSuccess: () => setDone(true),
      onError: (error) => setProblem(describeApiError(error)),
    });
  };
  return (
    <Dialog title={`Recover access to ${organisation.name}`} onClose={onClose} width="max-w-xl">
      {done ? (
        <div className="flex flex-col gap-4">
          <Callout tone="success" title="Back to monitor">Nobody is blocked now. The approved networks are kept, and the owners and admins have been told.</Callout>
          <CTAButton type="main" size="md" className="self-end" onClick={onClose}>Close</CTAButton>
        </div>
      ) : (
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <p className="text-sm text-secondary-text">
            Its network restrictions go back to <strong>monitor</strong>: nobody is blocked, the approved networks are kept, and the owners decide when to
            enforce again. Only do this for a request you have checked came from an owner.
          </p>
          <TextAreaField label="Why" required value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} hint="For example: the factory changed internet provider and nobody can get in." />
          <Field label="How ownership was verified" required value={verification} maxLength={1000} onChange={(e) => setVerification(e.target.value)} hint="For example: called the owner back on the number held for the account." />
          {problem && <Callout tone="error" role="alert">{problem}</Callout>}
          <div className="flex justify-end gap-2">
            <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
            <CTAButton type="danger" size="md" buttonType="submit" loading={recover.isPending}>Recover access</CTAButton>
          </div>
        </form>
      )}
    </Dialog>
  );
};

/** Every organisation: who owns it, how big it is, where its set-up and subscription stand. Billing and counts only. */
const OrganisationsPanel = () => {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(text);
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [text]);
  const query = usePlatformOrganisations({ search, limit: PAGE, offset });
  const [recovering, setRecovering] = useState(null);
  return (
    <div className="flex flex-col gap-4">
      <label className="flex max-w-md flex-col gap-1 text-sm text-primary-text">
        Search organisations or owners
        <input type="search" aria-label="Search organisations" className="rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-sm text-primary-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or owner email" />
      </label>
      <Panel query={query}>
        {(res) => (
          <Card title={`Organisations (${res.total})`} subtitle="Counts and billing only: no records, documents or quality data">
            <Table
              caption="Organisations"
              head={["Organisation", "Owners", "Members", "Set-up", "Subscription", "Seats", "MRR", "Network"]}
              empty={res.data.length === 0 ? (search ? "No organisation matches." : "No organisations yet.") : null}>
              {res.data.map((o) => (
                <tr key={o.organisationId} className="border-b border-border-color align-top last:border-0">
                  <td className="py-2 pr-3 text-primary-text">
                    <span className="flex items-center gap-1.5">
                      {o.name}
                      {o.status !== "active" ? <Pill tone={statusTone(o.status)}>{o.status}</Pill> : null}
                    </span>
                    <span className="block text-xs text-secondary-text">Created {day(o.createdAt)}{o.country ? ` · ${o.country}` : ""}</span>
                  </td>
                  <td className="py-2 pr-3 text-primary-text">{o.ownerEmails.length ? o.ownerEmails.map((e) => <span key={e} className="block">{e}</span>) : "—"}</td>
                  <td className="py-2 pr-3 text-primary-text">{o.members}</td>
                  <td className="py-2 pr-3 text-primary-text">{o.setupFinishedAt ? <Pill tone="good">Done</Pill> : <Pill tone="quiet">In progress</Pill>}</td>
                  <td className="py-2 pr-3 text-primary-text"><Subscription o={o} /></td>
                  <td className="py-2 pr-3 text-primary-text">{o.seatsAssigned} / {o.seatsPurchased}</td>
                  <td className="py-2 pr-3 text-primary-text">{o.mrrPence ? pounds(o.mrrPence) : "—"}</td>
                  <td className="py-2 text-primary-text">
                    {o.networkPolicy === "enforce" ? (
                      <span className="flex flex-col items-start gap-1">
                        <Pill tone="bad">Enforced</Pill>
                        <CTAButton type="neutral" size="default" onClick={() => setRecovering(o)}>Recover access</CTAButton>
                      </span>
                    ) : o.networkPolicy === "monitor" ? (
                      <Pill tone="quiet">Monitor</Pill>
                    ) : (
                      <span className="text-secondary-text">Off</span>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
            {res.total > PAGE && (
              <div className="mt-3 flex items-center justify-between gap-2 text-sm text-secondary-text">
                <span>{offset + 1}–{Math.min(offset + PAGE, res.total)} of {res.total}</span>
                <span className="flex gap-2">
                  <CTAButton buttonType="button" type="neutral" size="md" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</CTAButton>
                  <CTAButton buttonType="button" type="neutral" size="md" disabled={offset + PAGE >= res.total} onClick={() => setOffset(offset + PAGE)}>Next</CTAButton>
                </span>
              </div>
            )}
          </Card>
        )}
      </Panel>
      {recovering && <RecoverAccessDialog organisation={recovering} onClose={() => setRecovering(null)} />}
    </div>
  );
};

export default OrganisationsPanel;
