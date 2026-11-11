import { useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../../contexts/ToastProvider";
import { useSupplierMutation } from "../../hooks/useSupplierQuality";
import { describeApiError } from "../../lib/api-client";
import { MOVE_VERB, movesFrom, statusOf } from "../../lib/supplierQuality";
import Dialog from "../ui/Dialog";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { ApprovalPill } from "./SupplierBadges";
import CTAButton from "@/components/CTAButton";
import { todayIso } from "@/lib/localDate";

const field = "rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-sm font-normal text-primary-text focus:outline-none focus:border-brand-primary";

/** Move a supplier's approval status: only the moves that are allowed from where it is, always with a reason, and the conditions for a conditional approval. */
const StatusChangeDialog = ({ supplier, initial, onClose }) => {
  const mutation = useSupplierMutation();
  const { showToast } = useToast();
  // Approving (or approving conditionally) is a decision someone else makes: it is proposed on the Qualification tab, not done here.
  const allMoves = movesFrom(supplier.approvalStatus);
  const moves = allMoves.filter((m) => m !== "approved" && m !== "conditional");
  const approvalPossible = allMoves.length !== moves.length;
  const [status, setStatus] = useState(initial && moves.includes(initial) ? initial : moves[0]);
  const [reason, setReason] = useState("");
  const [conditions, setConditions] = useState("");
  const [reviewOn, setReviewOn] = useState(null);
  const conditional = status === "conditional";
  const ok = status && reason.trim().length >= 3 && (!conditional || conditions.trim());

  const submit = (e) => {
    e.preventDefault();
    if (!ok) return;
    mutation.mutate(
      { action: "status", id: supplier.id, body: { status, reason: reason.trim(), ...(conditional ? { conditions: conditions.trim() } : {}), ...(reviewOn ? { reviewOn } : {}) } },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Status changed", message: `${supplier.code} is now ${statusOf(status).label.toLowerCase()}.` });
          onClose();
        },
        onError: (err) => showToast({ type: "error", title: "Not changed", message: describeApiError(err) }),
      }
    );
  };

  return (
    <Dialog title="Change approval status" onClose={onClose}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <p className="flex items-center gap-2 text-sm text-primary-text">
          {supplier.code} · {supplier.name} <ApprovalPill status={supplier.approvalStatus} />
        </p>
        <fieldset>
          <legend className="text-sm font-medium text-secondary-text" data-required>
            Move to
          </legend>
          <div className="mt-1 flex flex-wrap gap-1">
            {moves.map((m) => (
              <label key={m} className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs ${status === m ? "border-brand-primary bg-brand-primary text-white" : "border-border-color hover:bg-border-color/40"}`}>
                <input type="radio" name="status" className="sr-only" checked={status === m} onChange={() => setStatus(m)} />
                {MOVE_VERB[m]}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1 text-sm font-medium text-secondary-text" data-required>
          Reason
          <textarea className={field} rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} aria-required="true" placeholder="Why is the status changing?" />
        </label>
        {conditional && (
          <label className="flex flex-col gap-1 text-sm font-medium text-secondary-text" data-required>
            Conditions or restrictions
            <textarea className={field} rows={3} maxLength={2000} value={conditions} onChange={(e) => setConditions(e.target.value)} aria-required="true" placeholder="What the approval depends on, e.g. inspect every delivery" />
          </label>
        )}
        {(conditional || status === "suspended") && (
          <RHFDatePickerPopout label="Review on" valueFormat="iso" clearable value={reviewOn} onChange={setReviewOn} minDate={todayIso()} placeholder="No date set" />
        )}
        {approvalPossible && (
          <p className="text-xs text-secondary-text">
            To approve this supplier, propose it on the <Link to={`/Suppliers/${supplier.id}?tab=qualification`} onClick={onClose} className="text-link-color hover:underline">Qualification tab</Link>: someone else decides it.
          </p>
        )}
        <p className="text-xs text-secondary-text">Every change is kept in the supplier's history with who made it and why.</p>
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type={status === "disqualified" || status === "suspended" ? "danger" : "main"} size="md" disabled={!ok || mutation.isPending} loading={mutation.isPending}>
            {mutation.isPending ? "Saving…" : status ? MOVE_VERB[status] : "Change"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

export default StatusChangeDialog;
