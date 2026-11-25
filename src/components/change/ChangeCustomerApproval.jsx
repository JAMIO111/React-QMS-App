import { useState } from "react";
import CTAButton from "@/components/CTAButton";
import { useToast } from "../../contexts/ToastProvider";
import { useChangeMutation } from "../../hooks/useChange";
import { formatDay } from "../../lib/change";
import { CHANGE_APPROVAL_STATUS } from "../../lib/portal";
import { FormError, TextAreaField } from "../master-data/shared";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";

/**
 * Ask a customer to approve the change in their portal (CH6b). Information only: their answer is recorded on this change's customer approval, and nothing else
 * moves. Staff can still record the customer's answer by hand.
 */
export const AskCustomerDialog = ({ change, customers, onClose }) => {
  const mutation = useChangeMutation();
  const { showToast } = useToast();
  const [partyId, setPartyId] = useState(customers.length === 1 ? customers[0].partyId : null);
  const [note, setNote] = useState("");
  const send = (e) => {
    e.preventDefault();
    if (!partyId) return;
    mutation.mutate(
      { action: "askCustomer", id: change.id, body: { partyId, note: note.trim() || null } },
      {
        onSuccess: (res) => {
          showToast({ type: "success", title: "Asked", message: res?.email?.sent ? "Their people have been emailed." : "They will see it on their portal." });
          onClose();
        },
      },
    );
  };
  return (
    <Dialog title={`Ask a customer to approve ${change.reference}`} onClose={onClose}>
      <form noValidate onSubmit={send} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">
          The customer sees what is changing, why, from when and which of their parts it covers, and answers in their portal. Their answer is recorded under Customer approval. It does not approve, hold or close anything else.
        </p>
        <ComboField label="Customer" required value={partyId} onChange={setPartyId} options={customers.map((c) => ({ value: c.partyId, label: c.name }))} sort={false} />
        <TextAreaField label="Message to them" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} hint="Optional" />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!partyId || mutation.isPending} loading={mutation.isPending}>Ask them</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const WithdrawDialog = ({ request, onClose }) => {
  const mutation = useChangeMutation();
  const [reason, setReason] = useState("");
  return (
    <Dialog title="Withdraw this request" onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim().length >= 3) mutation.mutate({ action: "withdrawCustomerApproval", id: request.id, body: { reason: reason.trim() } }, { onSuccess: onClose });
        }}>
        <p className="text-sm text-secondary-text">{request.customer} will no longer see it, and the customer approval goes back to "Required".</p>
        <TextAreaField label="Why" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Keep it</CTAButton>
          <CTAButton buttonType="submit" type="danger" size="md" disabled={reason.trim().length < 3 || mutation.isPending} loading={mutation.isPending}>Withdraw</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** The requests put to customers, newest first, with the customer's own words. */
export const ApprovalRequests = ({ requests, canWithdraw }) => {
  const [withdrawing, setWithdrawing] = useState(null);
  if (!requests?.length) return null;
  return (
    <div className="mt-4 flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-secondary-text">Asked in the portal</h3>
      <ul aria-label="Requests to customers" className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color">
        {requests.map((r) => {
          const status = r.status === "withdrawn" ? { label: "Withdrawn", tone: "bg-border-color text-secondary-text" } : (CHANGE_APPROVAL_STATUS[r.status] ?? CHANGE_APPROVAL_STATUS.pending);
          const waiting = r.status === "pending" ? { label: "Waiting for the customer", tone: status.tone } : status;
          return (
            <li key={r.id} className="flex flex-col gap-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-primary-text">{r.customer}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${waiting.tone}`}>{waiting.label}</span>
                <span className="text-xs text-secondary-text">
                  Asked {formatDay(r.requestedAt.slice(0, 10))}{r.requestedBy ? ` by ${r.requestedBy}` : ""}
                  {r.decidedAt ? ` · answered ${formatDay(r.decidedAt.slice(0, 10))}${r.decidedBy ? ` by ${r.decidedBy}` : ""}` : ""}
                </span>
                {r.status === "pending" && canWithdraw && (
                  <CTAButton type="neutral" size="default" aria-label={`Withdraw the request to ${r.customer}`} onClick={() => setWithdrawing(r)}>
                    Withdraw
                  </CTAButton>
                )}
              </div>
              {r.requestNote && <p className="text-secondary-text">You wrote: {r.requestNote}</p>}
              {r.decisionNote && <p className="text-primary-text">They wrote: {r.decisionNote}</p>}
              {r.customerReference && <p className="text-secondary-text">Their reference: {r.customerReference}</p>}
              {r.withdrawnReason && <p className="text-secondary-text">Withdrawn: {r.withdrawnReason}</p>}
            </li>
          );
        })}
      </ul>
      {withdrawing && <WithdrawDialog request={withdrawing} onClose={() => setWithdrawing(null)} />}
    </div>
  );
};

