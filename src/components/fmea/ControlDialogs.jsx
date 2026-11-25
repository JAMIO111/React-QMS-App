import { useState } from "react";
import CTAButton from "@/components/CTAButton";
import { useFmeaControlMutation, usePlanCharacteristics } from "../../hooks/useFmea";
import { carriableKinds, planCharacteristicOptions, planTargetWords } from "../../lib/fmea";
import { FormError, TextAreaField } from "../master-data/shared";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";

const Buttons = ({ onClose, pending, disabled, label, type = "main" }) => (
  <div className="flex justify-end gap-2">
    <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
      Cancel
    </CTAButton>
    <CTAButton buttonType="submit" type={type} size="md" disabled={disabled || pending} loading={pending}>
      {label}
    </CTAButton>
  </div>
);

/**
 * Carry a control of a cause to a control plan characteristic (FM11). The link names the plan, the operation and the characteristic's key, so it survives plan revisions; nothing
 * is copied into the plan. The special class of the failure mode is offered as a thought about the characteristic's criticality, never applied.
 */
export const CarryDialog = ({ cause, onClose }) => {
  const mutation = useFmeaControlMutation();
  const kinds = carriableKinds(cause);
  const [kind, setKind] = useState(kinds[0]?.value ?? "prevention");
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const targets = usePlanCharacteristics({ causeId: cause.id });
  const available = targets.data?.available !== false;
  const data = targets.data?.data ?? [];
  const chosen = data.find((c) => `${c.plan.id}|${c.operationCode}|${c.characteristicKey}` === target);
  const ready = kinds.length > 0 && target !== "";

  const send = (e) => {
    e.preventDefault();
    if (!ready || !chosen) return;
    const body = { controlKind: kind, controlPlanId: chosen.plan.id, operationCode: chosen.operationCode, characteristicKey: chosen.characteristicKey, note: note.trim() || undefined };
    mutation.mutate({ action: "carry", id: cause.id, body }, { onSuccess: onClose });
  };

  return (
    <Dialog title="Carry a control to the control plan" onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={send} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">
          Say which control plan characteristic checks “{cause.text}”. Nothing is copied into the plan: the link is kept here, so you can see at a glance whether the plan in force covers what the
          analysis says needs attention.
        </p>
        {kinds.length === 0 && <Callout tone="warning">Write a prevention or a detection control on this cause first, then carry it.</Callout>}
        {!available && <Callout tone="info">{targets.data?.reason ?? "You need to be able to read control plans to carry a control to one."}</Callout>}
        {kinds.length > 0 && available && (
          <>
            <ComboField label="Which control" required value={kind} onChange={(v) => setKind(v ?? kinds[0].value)} options={kinds} />
            <div className="rounded-lg border border-border-color bg-secondary-bg px-3 py-2 text-sm text-secondary-text">
              {kind === "prevention" ? cause.preventionControls : cause.detectionControls}
            </div>
            <ComboField
              label="Control plan characteristic"
              required
              value={target || null}
              onChange={(v) => setTarget(v ?? "")}
              options={planCharacteristicOptions(data)}
              placeholder={targets.isLoading ? "Loading…" : data.length === 0 ? "No control plan has a characteristic yet" : "Choose a characteristic"}
              hint="Plan · operation · characteristic. A characteristic that is only on a draft of the plan covers the cause once that revision is in force."
            />
            {chosen?.suggestion && <Callout tone="info">{chosen.suggestion}</Callout>}
            <TextAreaField label="Note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} hint="Optional: how the plan covers it" />
          </>
        )}
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label="Carry to the plan" />
      </form>
    </Dialog>
  );
};

/** End a carried control, with the reason. The link stays on record. */
export const EndLinkDialog = ({ link, onClose }) => {
  const mutation = useFmeaControlMutation();
  const [reason, setReason] = useState("");
  const send = (e) => {
    e.preventDefault();
    mutation.mutate({ action: "end", id: link.id, body: { reason: reason.trim() } }, { onSuccess: onClose });
  };
  return (
    <Dialog title="End the link to the control plan" onClose={onClose}>
      <form noValidate onSubmit={send} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">{planTargetWords(link)}</p>
        <TextAreaField label="Why does the link end?" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} required />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={reason.trim().length < 3} label="End the link" type="danger" />
      </form>
    </Dialog>
  );
};
