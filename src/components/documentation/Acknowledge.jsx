import { useState } from "react";
import Dialog from "../ui/Dialog";
import { useAlertMutation } from "../../hooks/useDocumentation";
import { referenceText } from "../../lib/qualityAlerts";
import { FormError, TextAreaField, buttonClass } from "../master-data/shared";

/** "I have read and understood": recorded with the person's name and the time. The alert's own words are shown first. */
export const AcknowledgeDialog = ({ alert, onClose }) => {
  const mutation = useAlertMutation();
  const [note, setNote] = useState("");
  return (
    <Dialog title={`Acknowledge ${referenceText(alert)}`} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({ action: "acknowledge", id: alert.id, body: note.trim() ? { note: note.trim() } : {} }, { onSuccess: onClose });
        }}>
        <p className="text-sm text-primary-text">
          <span className="font-medium">{alert.title}</span>
        </p>
        <p className="text-sm text-secondary-text">
          By acknowledging you confirm you have read this alert and understood what you must do. It is recorded with your name and the time, and cannot be changed.
        </p>
        <TextAreaField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} hint="e.g. what you have done about it" />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.neutral} onClick={onClose}>Cancel</button>
          <button type="submit" className={buttonClass.primary} disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "I have read and understood"}
          </button>
        </div>
      </form>
    </Dialog>
  );
};
