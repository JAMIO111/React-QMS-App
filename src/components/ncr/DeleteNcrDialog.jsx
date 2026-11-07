import { useState } from "react";
import Dialog from "../ui/Dialog";
import { useToast } from "../../contexts/ToastProvider";
import { useNcrMutation } from "../../hooks/useNcr";
import { describeApiError } from "../../lib/api-client";

/** Soft delete with a reason: the record is kept (and can be restored) but hidden from registers. */
const DeleteNcrDialog = ({ ncr, onClose, onDeleted }) => {
  const [reason, setReason] = useState("");
  const mutation = useNcrMutation();
  const { showToast } = useToast();

  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      { path: `/ncrs/${ncr.id}/delete`, body: { reason: reason.trim() } },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Deleted", message: `${ncr.reference} was deleted. It can be restored from the deleted records filter.` });
          onDeleted?.();
          onClose();
        },
      }
    );
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
        {mutation.error && (
          <p role="alert" className="text-sm text-error-color">
            {describeApiError(mutation.error)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-neutral-btn-bg-hover cursor-pointer">
            Cancel
          </button>
          <button
            type="submit"
            disabled={mutation.isPending || reason.trim().length < 3}
            className="rounded-lg border border-error-btn-border bg-error-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-error-btn-bg-hover disabled:opacity-50 cursor-pointer">
            {mutation.isPending ? "Deleting…" : "Delete"}
          </button>
        </div>
      </form>
    </Dialog>
  );
};

export default DeleteNcrDialog;
