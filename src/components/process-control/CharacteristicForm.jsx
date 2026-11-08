import { useState } from "react";
import Switch from "@/components/ui/Switch";
import { PlusIcon, Trash2Icon } from "@/components/icons";
import Field from "../ui/Field";
import { useToast } from "../../contexts/ToastProvider";
import { useUnits } from "../../hooks/useMasterData";
import { useGaugeTypes } from "../../hooks/useCalibration";
import {
  useCharacteristicTemplates,
  useProcessControlMutation,
} from "../../hooks/useProcessControl";
import {
  REACTION_ACTIONS,
  REACTION_TRIGGERS,
  SAMPLING_TRIGGERS,
} from "../../lib/processControl";
import {
  FormError,
  SelectField,
  TextAreaField,
} from "../master-data/shared";
import CTAButton from "@/components/CTAButton";

const toNumber = (v) =>
  v === "" || v === null || v === undefined ? null : Number(v);
const text = (v) => (v === null || v === undefined ? "" : String(v));

const KINDS = [
  {
    value: "fixed",
    label: "Fixed / common",
    hint: "Nominal and limits are set here and apply to every part in scope.",
  },
  {
    value: "variable",
    label: "Part-specific",
    hint: "Nominal and limits come from each part's specification value with this key.",
  },
  {
    value: "attribute",
    label: "Pass / fail",
    hint: "A visual or go/no-go check without a measured value.",
  },
  {
    value: "count",
    label: "Defect count",
    hint: "The number of defects found on each unit, e.g. scratches or missing rivets.",
  },
];
const nextSequence = (revision, operationId) =>
  Math.max(
    0,
    ...(revision.operations
      .find((o) => o.id === operationId)
      ?.characteristics.map((c) => c.sequence) ?? []),
  ) + 10;
const kindOf = (c) =>
  c.dataType === "attribute"
    ? "attribute"
    : c.dataType === "count"
      ? "count"
      : c.valueSource === "part_spec"
      ? "variable"
      : "fixed";

const Fieldset = ({ legend, children, className = "" }) => (
  <fieldset
    className={`flex flex-col gap-3 rounded-xl border border-border-color p-3 ${className}`}
  >
    <legend className="px-1 text-sm font-medium text-primary-text">
      {legend}
    </legend>
    {children}
  </fieldset>
);

/**
 * Add or edit a characteristic of a draft revision: what is checked (fixed limits, part-specific
 * values or pass/fail), at which operation, for which parts, how (method, gauge type), how often
 * (sampling rules), what to do on a failure (reactions) and whether it is charted (SPC).
 *
 * A new characteristic can start from a reusable template (Settings → Process control): picking one
 * copies its values into the form. With `asTemplate` the same form edits a template instead, without
 * the revision-specific fields (operation, drawing number, parts).
 */
const CharacteristicForm = ({
  revision,
  characteristic,
  operationId,
  onDone,
  asTemplate = false,
}) => {
  const mutation = useProcessControlMutation();
  const { showToast } = useToast();
  const units = useUnits();
  const gaugeTypes = useGaugeTypes();
  const templates = useCharacteristicTemplates({
    enabled: !asTemplate && !characteristic,
  });
  const c = characteristic;
  const [form, setForm] = useState({
    operationId: asTemplate
      ? null
      : (c?.operationId ?? operationId ?? revision.operations[0]?.id ?? null),
    description: text(c?.description),
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
    partIds: c?.parts?.map((p) => p.id) ?? [],
    method: text(c?.method),
    gaugeTypeId: c?.gaugeType?.id ?? null,
    criticality: c?.criticality ?? "minor",
    spcEligible: c?.spcEligible ?? false,
    chartType: c?.chartType && c.chartType !== "p" && c.chartType !== "defects" ? c.chartType : "imr", // "p" and "defects" are implied by the kind of check
    subgroupSize: text(c?.subgroupSize ?? 5),
    decimals: text(c?.decimals),
    notes: text(c?.notes),
    sampling: c?.sampling.map(({ triggerType, intervalValue, sampleSize }) => ({
      triggerType,
      intervalValue: text(intervalValue),
      sampleSize: text(sampleSize),
    })) ?? [{ triggerType: "first_off", intervalValue: "", sampleSize: "1" }],
    reactions:
      c?.reactions.map(({ triggerType, action, instruction }) => ({
        triggerType,
        action,
        instruction,
      })) ?? [],
  });
  const [problem, setProblem] = useState(null);
  const [templateId, setTemplateId] = useState(null);
  const set = (k) => (e) =>
    setForm((f) => ({
      ...f,
      [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value,
    }));
  const setValue = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const measured = form.kind === "fixed" || form.kind === "variable";

  const updateRow = (list, i, patch) =>
    setForm((f) => ({
      ...f,
      [list]: f[list].map((r, j) => (j === i ? { ...r, ...patch } : r)),
    }));
  const removeRow = (list, i) =>
    setForm((f) => ({ ...f, [list]: f[list].filter((_, j) => j !== i) }));

  // Copies a template's values; the operation, drawing number and parts of this revision stay as they are.
  const applyTemplate = (id) => {
    setTemplateId(id);
    const t = templates.data?.find((x) => x.id === id);
    if (!t) return;
    setForm((f) => ({
      ...f,
      characteristicKey: t.characteristicKey,
      name: t.name,
      kind: kindOf(t),
      nominal: text(t.nominal),
      lowerLimit: text(t.lowerLimit),
      upperLimit: text(t.upperLimit),
      unitCode: t.unitCode ?? f.unitCode,
      specKey: text(t.specKey),
      method: text(t.method),
      gaugeTypeId: t.gaugeType?.id ?? null,
      criticality: t.criticality,
      spcEligible: t.spcEligible,
      chartType: t.chartType && t.chartType !== "p" && t.chartType !== "defects" ? t.chartType : "imr",
      subgroupSize: text(t.subgroupSize ?? 5),
      decimals: text(t.decimals),
      notes: text(t.notes),
      sampling: t.sampling.map(
        ({ triggerType, intervalValue, sampleSize }) => ({
          triggerType,
          intervalValue: text(intervalValue),
          sampleSize: text(sampleSize),
        }),
      ),
      reactions: t.reactions.map(({ triggerType, action, instruction }) => ({
        triggerType,
        action,
        instruction,
      })),
    }));
  };

  const submit = (e) => {
    e.preventDefault();
    const nums = [form.nominal, form.lowerLimit, form.upperLimit].map(toNumber);
    if (
      form.kind === "fixed" &&
      nums.some((n) => n !== null && Number.isNaN(n))
    )
      return setProblem("Nominal and limits must be numbers.");
    if (
      !asTemplate &&
      form.appliesTo === "selected" &&
      form.partIds.length === 0
    )
      return setProblem(
        "Choose at least one part, or apply the check to all parts.",
      );
    setProblem(null);
    const content = {
      name: form.name.trim(),
      dataType: form.kind === "count" ? "count" : measured ? "variable" : "attribute",
      valueSource: form.kind === "variable" ? "part_spec" : "plan",
      nominal: form.kind === "fixed" ? nums[0] : null,
      lowerLimit: form.kind === "fixed" ? nums[1] : null,
      upperLimit: form.kind === "fixed" ? nums[2] : form.kind === "count" ? toNumber(form.upperLimit) : null,
      unitCode: measured ? form.unitCode : null,
      specKey: form.kind === "variable" ? form.specKey.trim() || null : null,
      method: form.method.trim(),
      gaugeTypeId: form.gaugeTypeId,
      criticality: form.criticality,
      // A measured check is charted as I-MR or X-bar/R; a pass/fail check as a P chart (proportion failed);
      // a defect count as defects per unit (the chart is a C or a U chart, chosen by the data).
      spcEligible: form.spcEligible,
      chartType: form.spcEligible ? (measured ? form.chartType : form.kind === "count" ? "defects" : "p") : null,
      subgroupSize:
        form.spcEligible && measured
          ? form.chartType === "imr"
            ? 1
            : toNumber(form.subgroupSize)
          : null,
      decimals: toNumber(form.decimals),
      notes: form.notes.trim(),
      sampling: form.sampling.map((s) => ({
        triggerType: s.triggerType,
        intervalValue: SAMPLING_TRIGGERS[s.triggerType].interval
          ? toNumber(s.intervalValue)
          : null,
        sampleSize: toNumber(s.sampleSize) ?? 1,
      })),
      reactions: form.reactions
        .map((r) => ({ ...r, instruction: r.instruction.trim() }))
        .filter((r) => r.instruction),
    };
    if (asTemplate) {
      const body = {
        ...content,
        description: form.description.trim(),
        characteristicKey: form.characteristicKey.trim(),
      };
      mutation.mutate(
        c
          ? { path: `/characteristic-templates/${c.id}`, method: "PATCH", body }
          : { path: "/characteristic-templates", body },
        {
          onSuccess: () => {
            showToast({
              type: "success",
              title: "Saved",
              message: `${body.name} saved.`,
            });
            onDone();
          },
        },
      );
      return;
    }
    const body = {
      ...content,
      operationId: form.operationId,
      charNumber: form.charNumber.trim(),
      appliesTo: form.appliesTo,
      partIds: form.appliesTo === "selected" ? form.partIds : [],
    };
    mutation.mutate(
      c
        ? {
            path: `/control-plan-characteristics/${c.id}`,
            method: "PATCH",
            body,
          }
        : {
            path: `/control-plan-revisions/${revision.id}/characteristics`,
            // New checks go after the operation's existing ones.
            body: {
              ...body,
              characteristicKey: form.characteristicKey.trim(),
              sequence: nextSequence(revision, form.operationId),
            },
          },
      {
        onSuccess: () => {
          showToast({
            type: "success",
            title: "Saved",
            message: `${form.name.trim()} saved in revision ${revision.revisionCode}.`,
          });
          onDone();
        },
      },
    );
  };

  const unitOptions = (units.data ?? []).map((u) => ({
    value: u.code,
    label: `${u.code} · ${u.name}`,
  }));

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4"
      aria-label={asTemplate ? "Characteristic template" : "Characteristic"}
    >
      {!asTemplate && !c && (templates.data?.length ?? 0) > 0 && (
        <SelectField
          label="Start from a template"
          placeholder="— Blank characteristic —"
          value={templateId}
          onChange={applyTemplate}
          options={templates.data.map((t) => ({
            value: t.id,
            label: `${t.name} (${t.characteristicKey})`,
          }))}
          hint="Fills in the fields below from Settings → Process control; you can still change them"
        />
      )}
      {asTemplate && (
        <Field
          label="Template name"
          value={form.name}
          onChange={set("name")}
          required
          maxLength={200}
          hint="e.g. Outer diameter ±0.05"
        />
      )}
      <div
        className={`grid grid-cols-1 gap-3 ${asTemplate ? "" : "sm:grid-cols-3"}`}
      >
        <Field
          label="Key"
          value={form.characteristicKey}
          onChange={set("characteristicKey")}
          required
          disabled={!!c && !asTemplate}
          maxLength={40}
          hint={
            c && !asTemplate
              ? "Identifies it across revisions"
              : "e.g. OD — kept across revisions"
          }
        />
        {!asTemplate && (
          <>
            <Field
              label="Number"
              value={form.charNumber}
              onChange={set("charNumber")}
              maxLength={20}
              hint="Balloon on the drawing (optional)"
            />
            <SelectField
              label="Operation"
              required
              value={form.operationId}
              onChange={setValue("operationId")}
              options={revision.operations.map((o) => ({
                value: o.id,
                label: `${o.operationCode} · ${o.name}`,
              }))}
            />
          </>
        )}
      </div>
      {asTemplate ? (
        <Field
          label="Description"
          value={form.description}
          onChange={set("description")}
          maxLength={1000}
          hint="Optional: when to use this template"
        />
      ) : (
        <Field
          label="Name"
          value={form.name}
          onChange={set("name")}
          required
          maxLength={200}
          hint="e.g. Outer diameter"
        />
      )}

      <Fieldset legend="Requirement">
        <div
          role="radiogroup"
          aria-label="Kind of check"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
        >
          {KINDS.map((k) => (
            <label
              key={k.value}
              className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-2 text-sm ${form.kind === k.value ? "border-brand-primary bg-brand-primary/10" : "border-border-color"}`}
            >
              <span className="flex items-center gap-2 font-medium text-primary-text">
                <input
                  type="radio"
                  name="kind"
                  value={k.value}
                  checked={form.kind === k.value}
                  onChange={() => setValue("kind")(k.value)}
                />{" "}
                {k.label}
              </span>
              <span className="text-xs text-secondary-text">{k.hint}</span>
            </label>
          ))}
        </div>
        {form.kind === "fixed" && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field
              label="Lower limit (LSL)"
              inputMode="decimal"
              value={form.lowerLimit}
              onChange={set("lowerLimit")}
              hint="Empty = no minimum"
            />
            <Field
              label="Nominal"
              inputMode="decimal"
              value={form.nominal}
              onChange={set("nominal")}
            />
            <Field
              label="Upper limit (USL)"
              inputMode="decimal"
              value={form.upperLimit}
              onChange={set("upperLimit")}
              hint="Empty = no maximum"
            />
            <SelectField
              label="Unit"
              required
              value={form.unitCode}
              onChange={setValue("unitCode")}
              options={unitOptions}
            />
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
            <SelectField
              label="Unit"
              required
              value={form.unitCode}
              onChange={setValue("unitCode")}
              options={unitOptions}
              hint="Part values must use this unit"
            />
          </div>
        )}
        {form.kind === "count" && (
          <Field
            label="Most defects allowed per unit"
            inputMode="numeric"
            value={form.upperLimit}
            onChange={set("upperLimit")}
            hint="Empty = defects are only counted, a unit never fails"
            className="sm:w-72"
          />
        )}
        {measured && (
          <Field
            label="Decimal places shown"
            inputMode="numeric"
            value={form.decimals}
            onChange={set("decimals")}
            hint="Display only; readings are stored as entered"
            className="sm:w-56"
          />
        )}
      </Fieldset>

      {!asTemplate && (
        <Fieldset legend="Applies to">
          <div className="flex flex-wrap gap-4 text-sm text-primary-text">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="appliesTo"
                checked={form.appliesTo === "all"}
                onChange={() => setValue("appliesTo")("all")}
              />{" "}
              All parts in the plan's scope
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="appliesTo"
                checked={form.appliesTo === "selected"}
                onChange={() => setValue("appliesTo")("selected")}
              />{" "}
              Selected parts only (conditional)
            </label>
          </div>
          {form.appliesTo === "selected" &&
            (revision.scopeParts.length === 0 ? (
              <p className="text-sm text-secondary-text">
                The plan's scope has no active parts yet.
              </p>
            ) : (
              <div
                className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto sm:grid-cols-3"
                role="group"
                aria-label="Parts"
              >
                {revision.scopeParts.map((p) => (
                  <label
                    key={p.id}
                    className="flex items-center gap-2 text-sm text-primary-text"
                  >
                    <input
                      type="checkbox"
                      checked={form.partIds.includes(p.id)}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          partIds: e.target.checked
                            ? [...f.partIds, p.id]
                            : f.partIds.filter((x) => x !== p.id),
                        }))
                      }
                    />
                    <span className="font-mono">{p.partNumber}</span>
                  </label>
                ))}
              </div>
            ))}
        </Fieldset>
      )}

      <Fieldset legend="How">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field
            label="Method"
            value={form.method}
            onChange={set("method")}
            maxLength={500}
            hint="e.g. Measure at 3 positions"
            className="sm:col-span-2"
          />
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
            options={(gaugeTypes.data ?? []).map((t) => ({
              value: t.id,
              label: t.name,
            }))}
            hint="Required equipment (from Calibration)"
          />
        </div>
      </Fieldset>

      <Fieldset legend="Sampling">
        {form.sampling.length === 0 && (
          <p className="text-sm text-secondary-text">
            No sampling rule: the check is only done when asked for.
          </p>
        )}
        {form.sampling.map((s, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_8rem_6rem_auto] items-end gap-2"
          >
            <SelectField
              label="When"
              required
              value={s.triggerType}
              onChange={(v) => updateRow("sampling", i, { triggerType: v })}
              options={Object.entries(SAMPLING_TRIGGERS).map(([value, t]) => ({
                value,
                label: t.label,
              }))}
            />
            {SAMPLING_TRIGGERS[s.triggerType].interval ? (
              <Field
                label={
                  SAMPLING_TRIGGERS[s.triggerType].interval === "minutes"
                    ? "Minutes"
                    : "Parts"
                }
                inputMode="numeric"
                value={s.intervalValue}
                required
                onChange={(e) =>
                  updateRow("sampling", i, { intervalValue: e.target.value })
                }
              />
            ) : (
              <span />
            )}
            <Field
              label="Sample size"
              inputMode="numeric"
              value={s.sampleSize}
              required
              onChange={(e) =>
                updateRow("sampling", i, { sampleSize: e.target.value })
              }
            />
            <CTAButton
              buttonType="button"
              type="danger" size="md"
              onClick={() => removeRow("sampling", i)}
              aria-label={`Remove sampling rule ${i + 1}`}
            >
              <Trash2Icon className="h-4 w-4" />
            </CTAButton>
          </div>
        ))}
        <CTAButton
          buttonType="button"
          type="neutral" size="md" className="flex w-fit items-center gap-1"
          onClick={() =>
            setForm((f) => ({
              ...f,
              sampling: [
                ...f.sampling,
                {
                  triggerType: "every_n_parts",
                  intervalValue: "",
                  sampleSize: "1",
                },
              ],
            }))
          }
        >
          <PlusIcon className="h-4 w-4" /> Add sampling rule
        </CTAButton>
      </Fieldset>

      <Fieldset legend="Reaction plan">
        {form.reactions.length === 0 && (
          <p className="text-sm text-secondary-text">
            No reaction for this characteristic beyond the revision's general
            reactions.
          </p>
        )}
        {form.reactions.map((r, i) => (
          <div
            key={i}
            className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[12rem_10rem_1fr_auto]"
          >
            <SelectField
              label="When"
              required
              value={r.triggerType}
              onChange={(v) => updateRow("reactions", i, { triggerType: v })}
              options={Object.entries(REACTION_TRIGGERS).map(
                ([value, label]) => ({ value, label }),
              )}
            />
            <SelectField
              label="Action"
              required
              value={r.action}
              onChange={(v) => updateRow("reactions", i, { action: v })}
              options={Object.entries(REACTION_ACTIONS).map(
                ([value, label]) => ({ value, label }),
              )}
            />
            <Field
              label="Instruction"
              value={r.instruction}
              required
              maxLength={2000}
              onChange={(e) =>
                updateRow("reactions", i, { instruction: e.target.value })
              }
            />
            <CTAButton
              buttonType="button"
              type="danger" size="md"
              onClick={() => removeRow("reactions", i)}
              aria-label={`Remove reaction ${i + 1}`}
            >
              <Trash2Icon className="h-4 w-4" />
            </CTAButton>
          </div>
        ))}
        <CTAButton
          buttonType="button"
          type="neutral" size="md" className="flex w-fit items-center gap-1"
          onClick={() =>
            setForm((f) => ({
              ...f,
              reactions: [
                ...f.reactions,
                { triggerType: "out_of_spec", action: "hold", instruction: "" },
              ],
            }))
          }
        >
          <PlusIcon className="h-4 w-4" /> Add reaction
        </CTAButton>
      </Fieldset>

      {form.kind === "attribute" && (
        <Fieldset legend="SPC">
          <Switch
            className="text-sm text-primary-text"
            checked={form.spcEligible}
            onChange={set("spcEligible")}
          >
            Chart this check (P chart: proportion of checks that fail, or NP
            chart: how many)
          </Switch>
          {form.spcEligible && (
            <p className="text-sm text-secondary-text">
              Each point is the share (P) or the number (NP) of checks that
              failed in a subgroup (one inspection, day or lot, chosen on the
              chart). The size of each subgroup is simply how many were
              checked; the NP chart uses subgroups of one size that you set or
              leave to be calculated.
            </p>
          )}
        </Fieldset>
      )}

      {form.kind === "count" && (
        <Fieldset legend="SPC">
          <Switch
            className="text-sm text-primary-text"
            checked={form.spcEligible}
            onChange={set("spcEligible")}
          >
            Chart this check (defects per unit)
          </Switch>
          {form.spcEligible && (
            <p className="text-sm text-secondary-text">
              Each point is the defects found in a subgroup (one inspection,
              day or lot, chosen on the chart). Every sample is one unit. The
              chart is a C chart when every subgroup inspects the same number
              of units and a U chart (defects per unit) when the number
              varies.
            </p>
          )}
        </Fieldset>
      )}

      {measured && (
        <Fieldset legend="SPC">
          <Switch
            className="text-sm text-primary-text"
            checked={form.spcEligible}
            onChange={set("spcEligible")}
          >
            Chart this characteristic (statistical process control)
          </Switch>
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
                <Field
                  label="Subgroup size"
                  inputMode="numeric"
                  value={form.subgroupSize}
                  onChange={set("subgroupSize")}
                  required
                  hint="Parts measured together each time"
                />
              )}
            </div>
          )}
        </Fieldset>
      )}

      <TextAreaField
        label="Notes"
        value={form.notes}
        onChange={set("notes")}
        maxLength={2000}
        rows={2}
      />
      {problem && (
        <p role="alert" className="text-sm text-error-color">
          {problem}
        </p>
      )}
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <CTAButton buttonType="button" type="neutral" size="md" onClick={onDone}>
          Cancel
        </CTAButton>
        <CTAButton
          buttonType="submit"
          type="main" size="lg"
          disabled={mutation.isPending}
        >
          {mutation.isPending
            ? "Saving…"
            : asTemplate
              ? "Save template"
              : "Save characteristic"}
        </CTAButton>
      </div>
    </form>
  );
};

export default CharacteristicForm;
