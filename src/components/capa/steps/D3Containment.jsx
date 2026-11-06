import { useState } from "react";
import MenuCard from "../../ui/MenuCard";
import { useCapaMutation } from "../../../hooks/useCapa";
import { FormError, TextAreaField, buttonClass } from "../../master-data/shared";
import ActionList from "../ActionList";

const NoContainment = ({ capa, editable }) => {
  const mutation = useCapaMutation();
  const [reason, setReason] = useState(capa.d3NoContainmentReason ?? "");
  const dirty = reason.trim() !== (capa.d3NoContainmentReason ?? "");
  return (
    <MenuCard title="No containment needed?" subtitle="If nothing needs protecting, say why instead of adding an action" as="form" aria-label="No containment" noValidate bodyClassName="flex flex-col gap-3"
      onSubmit={(e) => { e.preventDefault(); if (dirty) mutation.mutate({ action: "update", id: capa.id, body: { d3NoContainmentReason: reason.trim() || null } }); }}>
      <TextAreaField label="Why no containment is needed" value={reason} onChange={(e) => setReason(e.target.value)} disabled={!editable} rows={2} maxLength={2000} hint="e.g. no product has left the plant and none is in stock" />
      <FormError error={mutation.error} />
      {editable && (
        <div className="flex justify-end">
          <button type="submit" className={buttonClass.neutral} disabled={!dirty || mutation.isPending}>{mutation.isPending ? "Saving…" : "Save reason"}</button>
        </div>
      )}
    </MenuCard>
  );
};

/** D3: actions that protect the customer now, and stay until a permanent fix is proven. */
const D3Containment = ({ capa, editable }) => (
  <div className="flex flex-col gap-4">
    <ActionList capa={capa} phase="interim" editable={editable} title="Containment actions" addLabel="Add containment action"
      emptyText="No containment action yet. Sort, quarantine or inspect what could reach the customer, and give each action an owner and a date." />
    <NoContainment key={capa.updatedAt} capa={capa} editable={editable} />
  </div>
);

export default D3Containment;
