import { useState } from "react";
import CTAButton from "@/components/CTAButton";
import { useFmeaNodeMutation } from "../../hooks/useFmea";
import { useClassifications } from "../../hooks/useNcr";
import { EFFECT_LEVELS, ELEMENT_TYPES, itemKindLabel, ratingOptions, registerModeOptions, SPECIAL_CLASSES, toLevel } from "../../lib/fmea";
import { FormError, TextAreaField } from "../master-data/shared";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";

/**
 * One small form for every node of the analysis. `fields` describe the controls (`type`: text | area | combo; `name` is the key sent to the server); `initial` holds what
 * an existing node has. It waits for the server's answer (the database scores the causes) and stays open, saying why, when it is refused.
 */
const NodeDialog = ({ title, intro, fields, initial = {}, action, id, base = {}, onClose, button = "Save" }) => {
  const mutation = useFmeaNodeMutation();
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.name, initial[f.name] ?? ""])));
  const set = (name, value) => setValues((c) => ({ ...c, [name]: value }));
  const visible = fields.filter((f) => !f.when || f.when(values));
  const ready = visible.every((f) => !f.required || String(values[f.name] ?? "").trim() !== "");

  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { ...base };
    visible.forEach((f) => {
      const v = values[f.name];
      if (f.type === "combo" && f.level) body[f.name] = toLevel(v);
      else if (f.type === "combo") body[f.name] = v === "" ? null : v;
      else body[f.name] = String(v).trim() === "" ? (f.required ? undefined : null) : String(v).trim();
    });
    // a field that no longer applies (the work element's type after the kind changed) is cleared, not left behind
    fields.filter((f) => f.when && !f.when(values) && initial[f.name]).forEach((f) => (body[f.name] = null));
    mutation.mutate({ action, id, body }, { onSuccess: onClose });
  };

  return (
    <Dialog title={title} onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        {intro && <p className="text-sm text-secondary-text">{intro}</p>}
        {visible.map((f) =>
          f.type === "combo" ? (
            <ComboField key={f.name} label={f.label} value={values[f.name] === "" ? null : String(values[f.name])} onChange={(v) => set(f.name, v ?? "")} options={f.options} required={f.required} hint={f.hint} placeholder={f.placeholder ?? "Select..."} clearable={!f.required} />
          ) : f.type === "area" ? (
            <TextAreaField key={f.name} label={f.label} value={values[f.name]} onChange={(e) => set(f.name, e.target.value)} maxLength={f.max} rows={f.rows ?? 3} required={f.required} hint={f.hint} />
          ) : (
            <Field key={f.name} label={f.label} value={values[f.name]} onChange={(e) => set(f.name, e.target.value)} maxLength={f.max} required={f.required} hint={f.hint} placeholder={f.placeholder} />
          ),
        )}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!ready} loading={mutation.isPending}>
            {button}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Add or change an item of the structure. `kind` is fixed once the item exists (to change it, remove it and add the right kind). */
export const ItemDialog = ({ revision, parent, kind, existing, onClose }) => {
  const fields = [
    { name: "name", label: itemKindLabel(kind), type: "text", required: true, max: 200, placeholder: kind === "step" ? "e.g. OP10 Turn the bore" : undefined },
    { name: "elementType", label: "Type of work element", type: "combo", options: ELEMENT_TYPES, hint: "Man, machine, material, method, measurement or environment (4M)", when: () => kind === "element" },
    { name: "operationCode", label: "Operation code", type: "text", max: 40, hint: "Ties the step to a control plan operation", when: () => kind === "step" },
    { name: "description", label: "Description", type: "area", max: 1000, rows: 2 },
  ];
  return (
    <NodeDialog
      title={existing ? `Change ${itemKindLabel(kind).toLowerCase()}` : `Add a ${itemKindLabel(kind).toLowerCase()}`}
      fields={fields}
      initial={existing ?? {}}
      action={existing ? "updateItem" : "addItem"}
      id={existing ? existing.id : revision.id}
      base={existing ? {} : { kind, ...(parent ? { parentId: parent.id } : {}) }}
      button={existing ? "Save" : "Add"}
      onClose={onClose}
    />
  );
};

export const FunctionDialog = ({ item, existing, onClose }) => (
  <NodeDialog
    title={existing ? "Change the function" : `Add a function to ${item.name}`}
    intro="What it is meant to do, and the requirement it has to meet."
    fields={[
      { name: "text", label: "Function", type: "area", required: true, max: 1000, rows: 2, hint: "e.g. Turn the bore to 25.00 ±0.05" },
      { name: "requirement", label: "Requirement", type: "area", max: 1000, rows: 2 },
      { name: "characteristicKey", label: "Characteristic key", type: "text", max: 80, hint: "The control plan characteristic this function belongs to, if you use keys" },
    ]}
    initial={existing ?? {}}
    action={existing ? "updateFunction" : "addFunction"}
    id={existing ? existing.id : item.id}
    button={existing ? "Save" : "Add"}
    onClose={onClose}
  />
);

export const FailureModeDialog = ({ fn, existing, onClose }) => {
  const register = useClassifications();
  return (
    <NodeDialog
      title={existing ? "Change the failure mode" : "Add a failure mode"}
      intro={fn ? `How “${fn.text}” could go wrong.` : undefined}
      fields={[
        { name: "text", label: "Failure mode", type: "area", required: true, max: 500, rows: 2, hint: "e.g. Bore oversize" },
        { name: "specialClass", label: "Special characteristic", type: "combo", options: SPECIAL_CLASSES, hint: "Mark it when the customer or your own rules call it critical or significant" },
        {
          name: "ncrFailureModeId",
          label: "Failure mode in the non-conformance register",
          type: "combo",
          options: registerModeOptions(register.data?.failureModes, existing?.ncFailureMode),
          placeholder: register.isLoading ? "Loading…" : "Not tied",
          hint: "Tie it to what the register calls this failure, to see how many non-conformances have been raised against it",
        },
      ]}
      initial={existing ? { ...existing, ncrFailureModeId: existing.ncFailureMode?.id ?? "" } : {}}
      action={existing ? "updateFailureMode" : "addFailureMode"}
      id={existing ? existing.id : fn.id}
      button={existing ? "Save" : "Add"}
      onClose={onClose}
    />
  );
};

export const EffectDialog = ({ mode, existing, scale, onClose }) => (
  <NodeDialog
    title={existing ? "Change the effect" : "Add an effect"}
    intro="What happens, and how severe it is. The worst severity among a failure mode's effects is the one its causes are scored with."
    fields={[
      { name: "level", label: "Who sees it", type: "combo", options: EFFECT_LEVELS, required: true },
      { name: "text", label: "Effect", type: "area", required: true, max: 500, rows: 2, hint: "e.g. Part scrapped" },
      { name: "severity", label: "Severity (S)", type: "combo", level: true, options: ratingOptions(scale?.severity), hint: "Leave empty until the team has rated it" },
    ]}
    initial={existing ? { ...existing, severity: existing.severity == null ? "" : String(existing.severity) } : { level: "own_plant" }}
    action={existing ? "updateEffect" : "addEffect"}
    id={existing ? existing.id : mode.id}
    button={existing ? "Save" : "Add"}
    onClose={onClose}
  />
);

export const CauseDialog = ({ mode, existing, scale, onClose }) => (
  <NodeDialog
    title={existing ? "Change the cause" : "Add a cause"}
    intro="Why it could happen, how it is prevented and how it is caught. The database works out the RPN and the priority from your ratings."
    fields={[
      { name: "text", label: "Cause", type: "area", required: true, max: 500, rows: 2, hint: "e.g. Tool wear" },
      { name: "preventionControls", label: "Prevention controls", type: "area", max: 1000, rows: 2, hint: "What stops the cause from happening" },
      { name: "detectionControls", label: "Detection controls", type: "area", max: 1000, rows: 2, hint: "What would catch the cause or the failure" },
      { name: "occurrence", label: "Occurrence (O)", type: "combo", level: true, options: ratingOptions(scale?.occurrence) },
      { name: "detection", label: "Detection (D)", type: "combo", level: true, options: ratingOptions(scale?.detection) },
      { name: "noActionReason", label: "Why nothing more is done", type: "area", max: 500, rows: 2, hint: "Needed when the cause needs attention and no action is planned" },
    ]}
    initial={existing ? { ...existing, occurrence: existing.occurrence == null ? "" : String(existing.occurrence), detection: existing.detection == null ? "" : String(existing.detection) } : {}}
    action={existing ? "updateCause" : "addCause"}
    id={existing ? existing.id : mode.id}
    button={existing ? "Save" : "Add"}
    onClose={onClose}
  />
);
