import { useState } from "react";
import CTAButton from "@/components/CTAButton";
import { useToast } from "../../contexts/ToastProvider";
import { usePpapCustomerRequests, usePpapMutation } from "../../hooks/usePpap";
import { formatDay } from "../../lib/ppap";
import { PPAP_DECISION, PPAP_REQUEST_STATUS } from "../../lib/portal";
import { FormError, TextAreaField } from "../master-data/shared";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";

/**
 * Put a sent submission to the customer in their portal (PP4). Their answer is recorded as this submission's own decision, by the same rules as a decision
 * recorded by hand, and staff can still record it by hand.
 */

const AskDialog = ({ ppap, customer, onClose, supplier = false }) => {
  const mutation = usePpapMutation();
  const { showToast } = useToast();
  const [note, setNote] = useState("");
  return (
    <Dialog title={supplier ? `Ask ${customer.name} for ${ppap.reference}` : `Ask ${customer.name} to answer ${ppap.reference}`} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate(
            { action: supplier ? "askSupplier" : "askCustomer", id: ppap.id, body: { note: note.trim() || null } },
            {
              onSuccess: (res) => {
                showToast({ type: "success", title: "Asked", message: res?.email?.sent ? "Their people have been emailed." : "They will see it on their portal." });
                onClose();
              },
            },
          );
        }}>
        <p className="text-sm text-secondary-text">
          {supplier
            ? "The supplier sees the part, the level and the elements asked of them, and adds a file to each. When they submit, the package is recorded here as received and waits for our decision. They never see our own files or notes."
            : "The customer sees the part, the level, the elements by name and the signed warrant, never the evidence behind them. They approve it, approve it for now or reject it with a reason. Their answer is recorded here as the decision."}
        </p>
        <TextAreaField label="Message to them" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} hint="Optional" />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={mutation.isPending} loading={mutation.isPending}>Ask them</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const WithdrawDialog = ({ request, onClose }) => {
  const mutation = usePpapMutation();
  const [reason, setReason] = useState("");
  return (
    <Dialog title="Withdraw this request" onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim().length >= 3) mutation.mutate({ action: "withdrawCustomerRequest", id: request.id, body: { reason: reason.trim() } }, { onSuccess: onClose });
        }}>
        <p className="text-sm text-secondary-text">{request.customer} will no longer see it. The submission stays as it is.</p>
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

const SENT = ["submitted", "interim_approved", "approved", "rejected", "withdrawn"];

export const CustomerAnswerCard = ({ ppap }) => {
  const sent = ppap.direction === "submitted" && SENT.includes(ppap.status) && ppap.decisions.some((d) => d.kind === "submitted");
  const query = usePpapCustomerRequests(ppap.id, { enabled: sent });
  const [dialog, setDialog] = useState(null);
  if (!sent || !query.data) return null;
  const { data: requests = [], customer = null } = query.data;
  const waiting = requests.some((r) => r.status === "pending");
  const open = ["submitted", "interim_approved"].includes(ppap.status);
  const canAsk = ppap.canManage && open && customer && !waiting;
  if (requests.length === 0 && !canAsk && !(ppap.canManage && open)) return null;
  return (
    <MenuCard
      title="Customer's answer in the portal"
      subtitle="Put it to the customer and let them answer on their portal"
      action={canAsk ? <CTAButton type="main" onClick={() => setDialog({ kind: "ask" })}>Ask the customer</CTAButton> : undefined}>
      {!customer && ppap.canManage && open && <Callout tone="info">{ppap.customer?.name ?? "The customer"} is not set up for the portal. Turn it on under Settings, External access, and invite their people.</Callout>}
      {requests.length === 0 ? (
        <p className="px-4 py-3 text-sm text-secondary-text">Not put to the customer yet.</p>
      ) : (
        <ul aria-label="Requests to the customer" className="flex flex-col divide-y divide-border-color">
          {requests.map((r) => {
            const pill = r.status === "pending" ? PPAP_REQUEST_STATUS.pending : r.status === "withdrawn" ? { label: "Withdrawn", tone: "bg-border-color text-secondary-text" } : (PPAP_DECISION[r.decision] ?? PPAP_REQUEST_STATUS.answered);
            return (
              <li key={r.id} className="flex flex-col gap-1 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-primary-text">{r.customer}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${pill.tone}`}>{pill.label}</span>
                  <span className="text-xs text-secondary-text">
                    Asked {formatDay(r.requestedAt.slice(0, 10))}{r.requestedBy ? ` by ${r.requestedBy}` : ""}
                    {r.answeredAt ? ` · answered ${formatDay(r.answeredAt.slice(0, 10))}${r.answeredBy ? ` by ${r.answeredBy}` : ""}` : ""}
                  </span>
                  {r.status === "pending" && ppap.canManage && (
                    <CTAButton type="neutral" size="default" aria-label={`Withdraw the request to ${r.customer}`} onClick={() => setDialog({ kind: "withdraw", request: r })}>
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
      )}
      {dialog?.kind === "ask" && customer && <AskDialog ppap={ppap} customer={customer} onClose={() => setDialog(null)} />}
      {dialog?.kind === "withdraw" && <WithdrawDialog request={dialog.request} onClose={() => setDialog(null)} />}
    </MenuCard>
  );
};

/**
 * Ask a supplier to prepare and submit the package we are recording (PP5b). They add files in their portal and submit; the package is then recorded as received, and our
 * decision is recorded as before. Shown for a received package.
 */
export const SupplierPackageCard = ({ ppap }) => {
  const received = ppap.direction === "received";
  const query = usePpapCustomerRequests(ppap.id, { enabled: received });
  const [dialog, setDialog] = useState(null);
  if (!received || !query.data) return null;
  const { data: requests = [], supplier = null } = query.data;
  const waiting = requests.some((r) => r.status === "pending");
  const preparing = ["draft", "in_preparation"].includes(ppap.status);
  const canAsk = ppap.canManage && preparing && supplier && !waiting;
  if (requests.length === 0 && !(ppap.canManage && preparing)) return null;
  return (
    <MenuCard
      title="Supplier's package in the portal"
      subtitle="Ask the supplier to prepare and submit it themselves"
      action={canAsk ? <CTAButton type="main" onClick={() => setDialog({ kind: "ask" })}>Ask the supplier</CTAButton> : undefined}>
      {!supplier && ppap.canManage && preparing && <Callout tone="info">{ppap.supplier?.name ?? "The supplier"} is not set up for the portal. Turn it on under Settings, External access, and invite their people.</Callout>}
      {requests.length === 0 ? (
        <p className="px-4 py-3 text-sm text-secondary-text">Not asked of the supplier yet. You can also record the files yourself.</p>
      ) : (
        <ul aria-label="Requests to the supplier" className="flex flex-col divide-y divide-border-color">
          {requests.map((r) => {
            const pill = r.status === "pending" ? { label: "Waiting for the supplier", tone: PPAP_REQUEST_STATUS.pending.tone } : r.status === "withdrawn" ? { label: "Withdrawn", tone: "bg-border-color text-secondary-text" } : { label: "Submitted by the supplier", tone: "bg-success-color/15 text-success-color" };
            return (
              <li key={r.id} className="flex flex-col gap-1 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-primary-text">{r.customer}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${pill.tone}`}>{pill.label}</span>
                  <span className="text-xs text-secondary-text">
                    Asked {formatDay(r.requestedAt.slice(0, 10))}{r.requestedBy ? ` by ${r.requestedBy}` : ""}
                    {r.answeredAt ? ` · submitted ${formatDay(r.answeredAt.slice(0, 10))}${r.answeredBy ? ` by ${r.answeredBy}` : ""}` : ""}
                  </span>
                  {r.status === "pending" && ppap.canManage && (
                    <CTAButton type="neutral" size="default" aria-label={`Withdraw the request to ${r.customer}`} onClick={() => setDialog({ kind: "withdraw", request: r })}>
                      Withdraw
                    </CTAButton>
                  )}
                </div>
                {r.requestNote && <p className="text-secondary-text">You wrote: {r.requestNote}</p>}
                {r.decisionNote && <p className="text-primary-text">They wrote: {r.decisionNote}</p>}
                {r.withdrawnReason && <p className="text-secondary-text">Withdrawn: {r.withdrawnReason}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {dialog?.kind === "ask" && supplier && <AskDialog ppap={ppap} customer={supplier} supplier onClose={() => setDialog(null)} />}
      {dialog?.kind === "withdraw" && <WithdrawDialog request={dialog.request} onClose={() => setDialog(null)} />}
    </MenuCard>
  );
};
