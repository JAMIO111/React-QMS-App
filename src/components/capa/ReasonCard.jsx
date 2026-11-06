import { useState } from "react";
import MenuCard from "../ui/MenuCard";
import { useCapaMutation } from "../../hooks/useCapa";
import { FormError, TextAreaField, buttonClass } from "../master-data/shared";

/** A card with one free-text field saved with the 8D header (e.g. "no containment needed because…"). `field` is the API body key. */
const ReasonCard = ({ capa, editable, field, value, title, subtitle, label, hint, ariaLabel, saveLabel = "Save", rows = 2 }) => {
  const mutation = useCapaMutation();
  const [text, setText] = useState(value ?? "");
  const dirty = text.trim() !== (value ?? "");
  return (
    <MenuCard title={title} subtitle={subtitle} as="form" aria-label={ariaLabel ?? title} noValidate bodyClassName="flex flex-col gap-3"
      onSubmit={(e) => { e.preventDefault(); if (dirty) mutation.mutate({ action: "update", id: capa.id, body: { [field]: text.trim() || null } }); }}>
      <TextAreaField label={label} value={text} onChange={(e) => setText(e.target.value)} disabled={!editable} rows={rows} maxLength={4000} hint={hint} />
      <FormError error={mutation.error} />
      {editable && (
        <div className="flex justify-end">
          <button type="submit" className={buttonClass.neutral} disabled={!dirty || mutation.isPending}>{mutation.isPending ? "Saving…" : saveLabel}</button>
        </div>
      )}
    </MenuCard>
  );
};

export default ReasonCard;
