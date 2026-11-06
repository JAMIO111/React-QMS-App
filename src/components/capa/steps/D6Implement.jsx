import { useState } from "react";
import Dialog from "../../ui/Dialog";
import MenuCard from "../../ui/MenuCard";
import { useCapaMutation } from "../../../hooks/useCapa";
import { usePermissions } from "../../../hooks/useQmsApi";
import { formatDay } from "../../../lib/qualityAlerts";
import { FormError, TextAreaField, buttonClass } from "../../master-data/shared";
import ActionList from "../ActionList";

const STATE_TEXT = {
  none: { label: "Not verified yet", tone: "text-secondary-text" },
  effective: { label: "Verified effective", tone: "text-success-color" },
  failed: { label: "The last verification failed", tone: "text-error-color" },
  stale: { label: "The actions changed after the last verification: verify again", tone: "text-warning-color" },
};

const VerifyDialog = ({ capa, onClose }) => {
  const mutation = useCapaMutation();
  const [effective, setEffective] = useState(true);
  const [method, setMethod] = useState("");
  const [notes, setNotes] = useState("");
  return (
    <Dialog title="Verify the corrective actions" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({ action: "addVerification", id: capa.id, body: { effective, method: method.trim(), notes: notes.trim() || null } }, { onSuccess: onClose });
        }}>
        <fieldset className="flex flex-col gap-1 text-sm text-primary-text">
          <legend className="mb-1 font-medium">Did the corrective actions work?</legend>
          <label className="flex items-center gap-2"><input type="radio" name="effective" checked={effective} onChange={() => setEffective(true)} /> Yes, the problem has not come back</label>
          <label className="flex items-center gap-2"><input type="radio" name="effective" checked={!effective} onChange={() => setEffective(false)} /> No, it came back or the fix is not enough</label>
        </fieldset>
        <TextAreaField label="How effectiveness was checked" required value={method} onChange={(e) => setMethod(e.target.value)} rows={2} maxLength={200} hint="e.g. audit of the next 5 lots, 30 days of SPC" />
        <TextAreaField label={effective ? "Notes (optional)" : "What was found"} required={!effective} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={2000} />
        {!effective && <p className="text-sm text-warning-color">A failed verification reopens D5 and D6 so the actions can be put right.</p>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.neutral} onClick={onClose}>Cancel</button>
          <button type="submit" className={buttonClass.primary} disabled={mutation.isPending || !method.trim() || (!effective && !notes.trim())}>{mutation.isPending ? "Saving…" : "Record verification"}</button>
        </div>
      </form>
    </Dialog>
  );
};

/** D6: carry out the corrective actions with evidence, then check they worked (needs capa.verify). */
const D6Implement = ({ capa, editable }) => {
  const { can } = usePermissions();
  const [open, setOpen] = useState(false);
  const state = STATE_TEXT[capa.verificationState];
  return (
    <div className="flex flex-col gap-4">
      <ActionList capa={capa} phase="corrective" editable={editable} withCause title="Corrective actions" addLabel="Add corrective action"
        emptyText="No corrective action yet. Plan them in D5, then mark each one done here with its evidence." />
      <MenuCard title="Effectiveness verification" subtitle="Did the fix work? Needs the verify permission"
        action={editable && can("capa.verify") ? <button type="button" className={buttonClass.primary} onClick={() => setOpen(true)}>Verify effectiveness</button> : undefined}>
        <p className={`text-sm font-medium ${state.tone}`}>{state.label}</p>
        {capa.verifications.length > 0 && (
          <ul className="mt-2 flex flex-col divide-y divide-border-color" aria-label="Verifications">
            {capa.verifications.map((v) => (
              <li key={v.id} className="flex flex-col gap-1 py-2 text-sm">
                <p className="text-primary-text"><span className={`font-medium ${v.effective ? "text-success-color" : "text-error-color"}`}>{v.effective ? "Effective" : "Not effective"}</span> · {v.method}</p>
                {v.notes && <p className="text-xs text-primary-text">{v.notes}</p>}
                <p className="text-xs text-secondary-text">{v.verifiedBy?.name ?? "Someone"} on {formatDay(v.verifiedAt.slice(0, 10))}</p>
              </li>
            ))}
          </ul>
        )}
      </MenuCard>
      {open && <VerifyDialog capa={capa} onClose={() => setOpen(false)} />}
    </div>
  );
};

export default D6Implement;
