import { useState } from "react";
import Dialog from "../ui/Dialog";
import { describeApiError } from "../../lib/api-client";
import { TextAreaField } from "./Pickers";

/** Asks for a reason (cancel, reopen, delete…) before confirming. */
const ReasonDialog = ({ title, label, confirmText, onConfirm, onClose, pending, error }) => {
  const [reason, setReason] = useState("");
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(reason.trim());
        }}
        className="flex flex-col gap-3">
        <TextAreaField label={label} value={reason} onChange={setReason} maxLength={1000} />
        {error && (
          <p role="alert" className="text-sm text-error-color">
            {describeApiError(error)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-neutral-btn-bg-hover cursor-pointer">
            Back
          </button>
          <button type="submit" disabled={pending || reason.trim().length < 3} className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-cta-btn-bg-hover disabled:opacity-50 cursor-pointer">
            {pending ? "Saving…" : confirmText}
          </button>
        </div>
      </form>
    </Dialog>
  );
};

export default ReasonDialog;
