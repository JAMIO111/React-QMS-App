import { useState } from "react";
import MenuCard from "../ui/MenuCard";
import { useCapaMutation } from "../../hooks/useCapa";
import { TextAreaField } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";
import { useEditBase } from "../../hooks/useEditBase";

/** A card with one free-text field saved with the 8D header (e.g. "no containment needed because…"). `field` is the API body key. */
const ReasonCard = ({ capa, editable, field, value, title, subtitle, label, hint, ariaLabel, saveLabel = "Save", rows = 2, required = false }) => {
  const mutation = useCapaMutation();
  const [text, setText] = useState(value ?? "");
  const dirty = text.trim() !== (value ?? "");
  const versioned = useEditBase(capa, dirty);
  return (
    <MenuCard title={title} subtitle={subtitle} as="form" aria-label={ariaLabel ?? title} noValidate bodyClassName="flex flex-col gap-3"
      onSubmit={(e) => { e.preventDefault(); if (dirty) mutation.mutate({ action: "update", id: capa.id, body: versioned({ [field]: text.trim() || null }) }); }}>
      <TextAreaField label={label} required={required} value={text} onChange={(e) => setText(e.target.value)} disabled={!editable} rows={rows} maxLength={4000} hint={hint} />
      {editable && (
        <div className="flex justify-end">
          <CTAButton buttonType="submit" type="neutral" size="md" disabled={!dirty}>{saveLabel}</CTAButton>
        </div>
      )}
    </MenuCard>
  );
};

export default ReasonCard;
