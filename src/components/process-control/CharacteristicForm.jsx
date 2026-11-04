import { useState } from "react";
import { PlusIcon, Trash2Icon } from "@/components/icons";
import Field from "../ui/Field";
import { useToast } from "../../contexts/ToastProvider";
import { useUnits } from "../../hooks/useMasterData";
import { useGaugeTypes } from "../../hooks/useCalibration";
import { useProcessControlMutation } from "../../hooks/useProcessControl";
import { REACTION_ACTIONS, REACTION_TRIGGERS, SAMPLING_TRIGGERS } from "../../lib/processControl";
import { buttonClass, FormError, SelectField, TextAreaField } from "../master-data/shared";

const toNumber = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
const text = (v) => (v === null || v === undefined ? "" : String(v));

const KINDS = [
  { value: "fixed", label: "Fixed / common", hint: "Nominal and limits are set here and apply to every part in scope." },
  { value: "variable", label: "Part-specific", hint: "Nominal and limits come from each part's specification value with this key." },
  { value: "attribute", label: "Pass / fail", hint: "A visual or go/no-go check without a measured value." },
];
const nextSequence = (revision, operationId) =>
  Math.max(0, ...(revision.operations.find((o) => o.id === operationId)?.characteristics.map((c) => c.sequence) ?? [])) + 10;
const kindOf = (c) => (c.dataType === "attribute" ? "attribute" : c.valueSource === "part_spec" ? "variable" : "fixed");

const Fieldset = ({ legend, children, className = "" }) => (
  <fieldset className={`flex flex-col gap-3 rounded-xl border border-border-color p-3 ${className}`}>
    <legend className="px-1 text-sm font-medium text-primary-text">{legend}</legend>
    {children}
  </fieldset>
);

/**
 * Add or edit a characteristic of a draft revision: what is checked (fixed limits, part-specific
 * values or pass/fail), at which operation, for which parts, how (method, gauge type), how often
 * (sampling rules), what to do on a failure (reactions) and whether it is charted (SPC).
 */
const CharacteristicForm = ({ revision, characteristic, operationId, onDone }) => {
  const mutation = useProcessControlMutation();
  const { showToast } = useToast();
  const units = useUnits();
  const gaugeTypes = useGaugeTypes();
  const c = characteristic;
  const [form, setForm] = useState({
    operationId: c?.operationId ?? operationId ?? revision.operations[0]?.id ?? null,
    characteristicKey: c?.characteristicKey ?? "",
    charNumber: text(c?.charNumber),
    name: text(c?.name),
    kind: c ? kindOf(c) : "fixed",
    nominal: text(c?.nominal),
    lowerLimit: text(c?.lowerLimit),
    upperLimit: text(c?.upperLimit),
    unitCode: c?.unitCode ?? "mm",
    specKey: text(c?.specKey),
    appliesTo: c?.appliesTo ?? "all",
    partIds: c?.parts.map((p) => p.id) ?? [],
    method: text(c?.method),
    gaugeTypeId: c?.gaugeType?.id ?? null,
    criticality: c?.criticality ?? "minor",
    spcEligible: c?.spcEligible ?? false,
    chartType: c?.chartType ?? "imr",
    subgroupSize: text(c?.subgroupSize ?? 5),
    decimals: text(c?.decimals),
    notes: text(c?.notes),
    sampling: c?.sampling.map(({ triggerType, intervalValue, sampleSize }) => ({ triggerType, intervalValue: text(intervalValue), sampleSize: text(sampleSize) })) ?? [
      { triggerType: "first_off", intervalValue: "", sampleSize: "1" },
    ],
    reactions: c?.reactions.map(({ triggerType, action, instruction }) => ({ triggerType, action, instruction })) ?? [],
  });
  const [problem, setProblem] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const setValue = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const measured = form.kind !== "attribute";

  const updateRow = (list, i, patch) => setForm((f) => ({ ...f, [list]: f[list].map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const removeRow = (list, i) => setForm((f) => ({ ...f, [list]: f[list].filter((_, j) => j !== i) }));

  const submit = (e) => {
    e.preventDefault();
    const nums = [form.nominal, form.lowerLimit, form.upperLimit].map(toNumber);
    if (form.kind === "fixed" && nums.some((n) => n !== null && Number.isNaN(n))) return setProblem("Nominal and limits must be numbers.");
    if (form.appliesTo === "selected" && form.partIds.length === 0) return setProblem("Choose at least one part, or apply the check to all parts.");
    setProblem(null);
    const body = {
      operationId: form.operationId,
      charNumber: form.charNumber.trim(),
      name: form.name.trim(),
      dataType: measured ? "variable" : "attribute",
      valueSource: form.kind === "variable" ? "part_spec" : "plan",
      appliesTo: form.appliesTo,
      nominal: form.kind === "fixed" ? nums[0] : null,
      lowerLimit: form.kind === "fixed" ? nums[1] : null,
      upperLimit: form.kind === "fixed" ? nums[2] : null,
      unitCode: measured ? form.unitCode : null,
      specKey: form.kind === "variable" ? form.specKey.trim() || null : null,
      method: form.method.trim(),
      gaugeTypeId: form.gaugeTypeId,
      criticality: form.criticality,
      spcEligible: measured && form.spcEligible,
      chartType: measured && form.spcEligible ? form.chartType : null,
      subgroupSize: measured && form.spcEligible ? (form.chartType === "imr" ? 1 : toNumber(form.subgroupSize)) : null,
      decimals: toNumber(form.decimals),
      notes: form.notes.trim(),
      partIds: form.appliesTo === "selected" ? form.partIds : [],
      sampling: form.sampling.map((s) => ({
        triggerType: s.triggerType,
        intervalValue: SAMPLING_TRIGGERS[s.triggerType].interval ? toNumber(s.intervalValue) : null,
        sampleSize: toNumber(s.sampleSize) ?? 1,
      })),
      reactions: form.reactions.map((r) => ({ ...r, instruction: r.instruction.trim() })).filter((r) => r.instruction),
    };
    mutation.mutate(
      c
        ? { path: `/control-plan-characteristics/${c.id}`, method: "PATCH", body }
        : {
            path: `/control-plan-revisions/${revision.id}/characteristics`,
            // New checks go after the operation's existing ones.
            body: { ...body, characteristicKey: form.characteristicKey.trim(), sequence: nextSequence(revision, form.operationId) },
          },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Saved", message: `${form.name.trim()} saved in revision ${revision.revisionCode}.` });
          onDone();
        },
      }
    );
  };

  const unitOptions = (units.data ?? []).map((u) => ({ value: u.code, label: `${u.code} · ${u.name}` }));

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Characteristic">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field
          label="Key"
          value={form.characteristicKey}
          onChange={set("characteristicKey")}
          required
          disabled={!!c}
          maxLength={40}
          hint={c ? "Identifies it across revisions" : "e.g. OD — kept across revisions"}
        />
        <Field label="Number" value={form.charNumber} onChange={set("charNumber")} maxLength={20} hint="Balloon on the drawing (optional)" />
        <SelectField
          label="Operation"
          required
          value={form.operationId}
          onChange={setValue("operationId")}
          options={revision.operations.map((o) => ({ value: o.id, label: `${o.operationCode} · ${o.name}` }))}
        />
      </div>
      <Field label="Name" value={form.name} onChange={set("name")} required maxLength={200} hint="e.g. Outer diameter" />

      <Fieldset legend="Requirement">
        <div role="radiogroup" aria-label="Kind of check" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {KINDS.map((k) => (
            <label
              key={k.value}
              className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-2 text-sm ${form.kind === k.value ? "border-brand-primary bg-brand-primary/10" : "border-border-color"}`}>
              <span className="flex items-center gap-2 font-medium text-primary-text">
                <input type="radio" name="kind" value={k.value} checked={form.kind === k.value} onChange={() => setValue("kind")(k.value)} /> {k.label}
              </span>
              <span className="text-xs text-secondary-text">{k.hint}</span>
            </label>
          ))}
        </div>
        {form.kind === "fixed" && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Lower limit (LSL)" inputMode="decimal" value={form.lowerLimit} onChange={set("lowerLimit")} hint="Empty = no minimum" />
            <Field label="Nominal" inputMode="decimal" value={form.nominal} onChange={set("nominal")} />
            <Field label="Upper limit (USL)" inputMode="decimal" value={form.upperLimit} onChange={set("upperLimit")} hint="Empty = no maximum" />
            <SelectField label="Unit" required value={form.unitCode} onChange={setValue("unitCode")} options={unitOptions} />
          </div>
        )}
        {form.kind === "variable" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Specification key"
              value={form.specKey}
              onChange={set("specKey")}
              required
              maxLength={40}
              hint="Matches the value on each part revision, e.g. LENGTH"
            />
            <SelectField label="Unit" required value={form.unitCode} onChange={setValue("unitCode")} options={unitOptions} hint="Part values must use this unit" />
          </div>
        )}
        {measured && (
          <Field label="Decimal places shown" inputMode="numeric" value={form.decimals} onChange={set("decimals")} hint="Display only; readings are stored as entered" className="sm:w-56" />
        )}
      </Fieldset>

      <Fieldset legend="Applies to">
        <div className="flex flex-wrap gap-4 text-sm text-primary-text">
          <label className="flex items-center gap-2">
            <input type="radio" name="appliesTo" checked={form.appliesTo === "all"} onChange={() => setValue("appliesTo")("all")} /> All parts in the plan's scope
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="appliesTo" checked={form.appliesTo === "selected"} onChange={() => setValue("appliesTo")("selected")} /> Selected parts only (conditional)
          </label>
        </div>
        {form.appliesTo === "selected" &&
          (revision.scopeParts.length === 0 ? (
            <p className="text-sm text-secondary-text">The plan's scope has no active parts yet.</p>
          ) : (
            <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto sm:grid-cols-3" role="group" aria-label="Parts">
              {revision.scopeParts.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm text-primary-text">
                  <input
                    type="checkbox"
                    checked={form.partIds.includes(p.id)}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, partIds: e.target.checked ? [...f.partIds, p.id] : f.partIds.filter((x) => x !== p.id) }))
                    }
                  />
                  <span className="font-mono">{p.partNumber}</span>
                </label>
              ))}
            </div>
          ))}
      </Fieldset>

      <Fieldset legend="How">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Method" value={form.method} onChange={set("method")} maxLength={500} hint="e.g. Measure at 3 positions" className="sm:col-span-2" />
          <SelectField
            label="Criticality"
            required
            value={form.criticality}
            onChange={setValue("criticality")}
            options={[
              { value: "critical", label: "Critical" },
              { value: "major", label: "Major" },
              { value: "minor", label: "Minor" },
            ]}
          />
          <SelectField
            label="Gauge type"
            placeholder="Any suitable gauge"
            value={form.gaugeTypeId}
            onChange={setValue("gaugeTypeId")}
            options={(gaugeTypes.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
            hint="Required equipment (from Calibration)"
          />
        </div>
      </Fieldset>

      <Fieldset legend="Sampling">
        {form.sampling.length === 0 && <p className="text-sm text-secondary-text">No sampling rule: the check is only done when asked for.</p>}
        {form.sampling.map((s, i) => (
          <div key={i} className="grid grid-cols-[1fr_8rem_6rem_auto] items-end gap-2">
            <SelectField
              label="When"
              required
              value={s.triggerType}
              onChange={(v) => updateRow("sampling", i, { triggerType: v })}
              options={Object.entries(SAMPLING_TRIGGERS).map(([value, t]) => ({ value, label: t.label }))}
            />
            {SAMPLING_TRIGGERS[s.triggerType].interval ? (
              <Field
                label={SAMPLING_TRIGGERS[s.triggerType].interval === "minutes" ? "Minutes" : "Parts"}
                inputMode="numeric"
                value={s.intervalValue}
                required
                onChange={(e) => updateRow("sampling", i, { intervalValue: e.target.value })}
              />
            ) : (
              <span />
            )}
            <Field label="Sample size" inputMode="numeric" value={s.sampleSize} required onChange={(e) => updateRow("sampling", i, { sampleSize: e.target.value })} />
            <button type="button" className={buttonClass.danger} onClick={() => removeRow("sampling", i)} aria-label={`Remove sampling rule ${i + 1}`}>
              <Trash2Icon className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className={`${buttonClass.neutral} flex w-fit items-center gap-1`}
          onClick={() => setForm((f) => ({ ...f, sampling: [...f.sampling, { triggerType: "every_n_parts", intervalValue: "", sampleSize: "1" }] }))}>
          <PlusIcon className="h-4 w-4" /> Add sampling rule
        </button>
      </Fieldset>

      <Fieldset legend="Reaction plan">
        {form.reactions.length === 0 && <p className="text-sm text-secondary-text">No reaction for this characteristic beyond the revision's general reactions.</p>}
        {form.reactions.map((r, i) => (
          <div key={i} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[12rem_10rem_1fr_auto]">
            <SelectField
              label="When"
              required
              value={r.triggerType}
              onChange={(v) => updateRow("reactions", i, { triggerType: v })}
              options={Object.entries(REACTION_TRIGGERS).map(([value, label]) => ({ value, label }))}
            />
            <SelectField
              label="Action"
              required
              value={r.action}
              onChange={(v) => updateRow("reactions", i, { action: v })}
              options={Object.entries(REACTION_ACTIONS).map(([value, label]) => ({ value, label }))}
            />
            <Field label="Instruction" value={r.instruction} required maxLength={2000} onChange={(e) => updateRow("reactions", i, { instruction: e.target.value })} />
            <button type="button" className={buttonClass.danger} onClick={() => removeRow("reactions", i)} aria-label={`Remove reaction ${i + 1}`}>
              <Trash2Icon className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className={`${buttonClass.neutral} flex w-fit items-center gap-1`}
          onClick={() => setForm((f) => ({ ...f, reactions: [...f.reactions, { triggerType: "out_of_spec", action: "hold", instruction: "" }] }))}>
          <PlusIcon className="h-4 w-4" /> Add reaction
        </button>
      </Fieldset>

      {measured && (
        <Fieldset legend="SPC">
          <label className="flex items-center gap-2 text-sm text-primary-text">
            <input type="checkbox" checked={form.spcEligible} onChange={set("spcEligible")} /> Chart this characteristic (statistical process control)
          </label>
          {form.spcEligible && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <SelectField
                label="Chart"
                required
                value={form.chartType}
                onChange={setValue("chartType")}
                options={[
                  { value: "imr", label: "I-MR (one reading at a time)" },
                  { value: "xbar_r", label: "X-bar/R (subgroups of 2–10)" },
                ]}
              />
              {form.chartType === "xbar_r" && (
                <Field label="Subgroup size" inputMode="numeric" value={form.subgroupSize} onChange={set("subgroupSize")} required hint="Parts measured together each time" />
              )}
            </div>
          )}
        </Fieldset>
      )}

      <TextAreaField label="Notes" value={form.notes} onChange={set("notes")} maxLength={2000} rows={2} />
      {problem && (
        <p role="alert" className="text-sm text-error-color">
          {problem}
        </p>
      )}
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass.neutral} onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className={buttonClass.primary} disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save characteristic"}
        </button>
      </div>
    </form>
  );
};

export default CharacteristicForm;
