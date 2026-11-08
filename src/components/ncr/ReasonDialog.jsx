import { useState } from "react";
import Dialog from "../ui/Dialog";
import { describeApiError } from "../../lib/api-client";
import { TextAreaField } from "./Pickers";
import CTAButton from "@/components/CTAButton";

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
        <TextAreaField label={label} required value={reason} onChange={setReason} maxLength={1000} />
        {error && (
          <p role="alert" className="text-sm text-error-color">
            {describeApiError(error)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" onClick={onClose} type="neutral" size="md">
            Back
          </CTAButton>
          <CTAButton buttonType="submit" disabled={pending || reason.trim().length < 3} type="main" size="md">
            {pending ? "Saving…" : confirmText}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

export default ReasonDialog;
