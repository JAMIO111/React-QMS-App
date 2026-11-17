import { useState } from "react";
import Dialog from "../ui/Dialog";
import { useNcrMutation } from "../../hooks/useNcr";
import { ncrDelete } from "../../lib/ncrGuesses";
import CTAButton from "@/components/CTAButton";

/** Soft delete with a reason: the record is kept (and can be restored) but hidden from registers. */
const DeleteNcrDialog = ({ ncr, onClose, onDeleted }) => {
  const [reason, setReason] = useState("");
  const mutation = useNcrMutation();

  const submit = (e) => {
    e.preventDefault();
    // Gone from the register at once; a refusal (e.g. a running 8D links it) brings it back and is told in a toast (useNcrMutation).
    mutation.mutate({ path: `/ncrs/${ncr.id}/delete`, body: { reason: reason.trim() }, guess: ncrDelete(ncr.id, reason.trim()), failed: "Not deleted" });
    onDeleted?.();
    onClose();
  };

  return (
    <Dialog title={`Delete ${ncr.reference}?`} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">
          The record is kept for the audit trail and can be restored, but it disappears from the register.
        </p>
        <label className="flex flex-col gap-1 text-sm font-medium text-primary-text">
          Reason for deleting
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={3}
            maxLength={1000}
            rows={3}
            className="rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-sm font-normal text-primary-text focus:outline-none focus:border-brand-primary"
          />
        </label>
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" onClick={onClose} type="neutral" size="md">
            Cancel
          </CTAButton>
          <CTAButton
            buttonType="submit"
            disabled={reason.trim().length < 3}
            type="danger" size="md">
            Delete
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

export default DeleteNcrDialog;
