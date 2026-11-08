import { useState } from "react";
import { Link } from "react-router-dom";
import Dialog from "../../ui/Dialog";
import MenuCard from "../../ui/MenuCard";
import { useCapaMutation } from "../../../hooks/useCapa";
import { usePermissions } from "../../../hooks/useQmsApi";
import { formatDay } from "../../../lib/qualityAlerts";
import { FormError, TextAreaField } from "../../master-data/shared";
import CapaFiles from "../CapaFiles";
import CTAButton from "@/components/CTAButton";

const CloseDialog = ({ capa, onClose }) => {
  const mutation = useCapaMutation();
  const [note, setNote] = useState("");
  return (
    <Dialog title={`Close ${capa.reference}?`} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({ action: "close", id: capa.id, body: { recognition: note.trim() || null } }, { onSuccess: onClose });
        }}>
        <p className="text-sm text-primary-text">Closing signs the 8D off. It becomes read-only until someone reopens it.</p>
        <TextAreaField label="Recognition of the team (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} hint="Who did what, and what the organisation should thank them for" />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending}>{mutation.isPending ? "Closing…" : "Close 8D"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** D8: sign the 8D off and recognise the team; evidence files; the printable report. */
const D8Close = ({ capa, editable }) => {
  const { can } = usePermissions();
  const [open, setOpen] = useState(false);
  const closed = capa.stage === "closed";
  const ready = capa.steps.find((s) => s.step === "d8")?.problems.length === 0;
  return (
    <div className="flex flex-col gap-4">
      <MenuCard title={closed ? "Closed" : "Close the 8D"} subtitle={closed ? undefined : "Needs the verify permission, every step done and the corrective actions verified as effective"}
        action={editable && can("capa.verify") && !closed ? <CTAButton buttonType="button" type="main" size="lg" disabled={!ready} onClick={() => setOpen(true)}>Close 8D</CTAButton> : undefined}>
        {closed ? (
          <div className="flex flex-col gap-2 text-sm text-primary-text">
            <p>Closed by {capa.closedBy?.name ?? "someone"} on {formatDay(capa.closedAt.slice(0, 10))}.</p>
            {capa.d8Recognition && <p><span className="text-secondary-text">Recognition: </span>{capa.d8Recognition}</p>}
          </div>
        ) : (
          <p className="text-sm text-secondary-text">{ready ? "Everything is in place. Add the recognition note when you close." : "Finish what the list below asks for first."}</p>
        )}
        <p className="mt-3 text-sm"><Link className="text-link-color hover:underline" to={`/CAPA/${capa.id}/report`}>Open the printable report</Link></p>
      </MenuCard>
      <CapaFiles capaId={capa.id} canEdit={editable} />
      {open && <CloseDialog capa={capa} onClose={() => setOpen(false)} />}
    </div>
  );
};

export default D8Close;
