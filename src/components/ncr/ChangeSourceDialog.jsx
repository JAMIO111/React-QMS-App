import { useState } from "react";
import Dialog from "../ui/Dialog";
import RHFComboBox from "../ui/RHFComboBox";
import { InboxIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useNcrMutation } from "../../hooks/useNcr";
import { describeApiError } from "../../lib/api-client";
import { SOURCE_OPTIONS, sourceLabel } from "../../lib/ncr";
import { TextAreaField } from "./Pickers";

/**
 * Change where a non-conformance came from. A reason is needed and is kept in the history. The database refuses the move when
 * the new source needs something the record lacks (a customer or a supplier), and the answer is shown here.
 */
const ChangeSourceDialog = ({ ncr, onClose }) => {
  const mutation = useNcrMutation();
  const { showToast } = useToast();
  const [source, setSource] = useState(null);
  const [reason, setReason] = useState("");
  const ready = !!source && reason.trim().length >= 3;
  return (
    <Dialog title={`Change the source of ${ncr.reference}`} onClose={onClose}>
      <form
        noValidate
        onSubmit={(e) => {
          // This dialog is rendered inside the NC page, whose own form must not receive the submit.
          e.preventDefault();
          e.stopPropagation();
          if (!ready) return;
          mutation.mutate(
            { path: `/ncrs/${ncr.id}/source`, body: { source, reason: reason.trim() } },
            {
              onSuccess: () => {
                showToast({ type: "success", title: "Source changed", message: `${ncr.reference} now comes from ${sourceLabel(source).toLowerCase()}.` });
                onClose();
              },
            },
          );
        }}
        className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">
          Now: <strong className="text-primary-text">{sourceLabel(ncr.source)}</strong>. What was already entered (customer, supplier, purchase order) is kept.
        </p>
        <RHFComboBox
          label="New source"
          required
          icon={InboxIcon}
          placeholder="Select a source"
          sort={false}
          clearable={false}
          options={SOURCE_OPTIONS.filter((o) => o.id !== ncr.source)}
          value={source}
          onChange={setSource}
        />
        <TextAreaField label="Why is the source changing?" required value={reason} onChange={setReason} maxLength={1000} />
        {mutation.error && (
          <p role="alert" className="text-sm text-error-color">
            {describeApiError(mutation.error)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-neutral-btn-bg-hover cursor-pointer">
            Back
          </button>
          <button type="submit" disabled={mutation.isPending || !ready} className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-cta-btn-bg-hover disabled:opacity-50 cursor-pointer">
            {mutation.isPending ? "Saving…" : "Change source"}
          </button>
        </div>
      </form>
    </Dialog>
  );
};

export default ChangeSourceDialog;
