import { useEffect, useState } from "react";
import { useToast } from "../../contexts/ToastProvider";
import { useCustomFieldPeople, useCustomFields, useSetCustomValues } from "../../hooks/useCustomFields";
import { describeApiError } from "../../lib/api-client";
import { formatCustomValue, groupBySection, isMissing, requiredLabel } from "../../lib/customFields";
import ComboField from "../ui/ComboField";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import Switch from "../ui/Switch";

const inputClass =
  "w-full rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-sm text-primary-text outline-none hover:border-border-dark-color focus:border-brand-primary focus:ring-3 focus:ring-brand-primary/20 disabled:opacity-60";

/** A text box that saves when left (or Enter, for one line) if its text changed. */
const TextEditor = ({ id, field, value, onSave, multiline, inputMode, required, describedBy }) => {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => setText(value == null ? "" : String(value)), [value]);
  const commit = () => {
    const next = text.trim();
    if (next !== (value == null ? "" : String(value))) onSave(next === "" ? null : field.fieldType === "number" ? next.replace(",", ".") : next);
  };
  const props = {
    id,
    value: text,
    onChange: (e) => setText(e.target.value),
    onBlur: commit,
    className: inputClass,
    "aria-required": required || undefined,
    "aria-describedby": describedBy,
  };
  return multiline ? (
    <textarea rows={3} maxLength={5000} {...props} />
  ) : (
    <input
      type="text"
      inputMode={inputMode}
      maxLength={field.fieldType === "number" ? 40 : 500}
      {...props}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
};

/** One field: its control by type when it can be changed, else its value as words. */
const FieldRow = ({ field, value, editable, people, stages, onSave }) => {
  const id = `cf-${field.id}`;
  const rule = requiredLabel(field.requiredAt, stages);
  const required = field.requiredAt === "save";
  const missing = rule && isMissing(value);
  const help = [field.helpText, field.fieldType === "number" && [field.min != null && `at least ${field.min}`, field.max != null && `at most ${field.max}`].filter(Boolean).join(", "), rule && !required && rule].filter(Boolean).join(" · ");
  const helpId = help ? `${id}-help` : undefined;
  const label = (
    <span className="text-sm font-medium text-secondary-text" data-required={required || undefined}>
      {field.label}
      {field.fieldType === "number" && field.unit ? ` (${field.unit})` : ""}
      {!field.active && <span className="ml-1 text-xs font-normal">(retired)</span>}
    </span>
  );

  if (!editable || !field.active) {
    const text = formatCustomValue(field, value, people);
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        {label}
        <span className={`text-sm ${text ? "text-primary-text" : "text-secondary-text"} whitespace-pre-wrap break-words`}>{text || "—"}</span>
        {missing && <span className="text-xs text-warning-color">{rule}</span>}
      </div>
    );
  }

  let control;
  switch (field.fieldType) {
    case "boolean":
      control = (
        <Switch checked={value === true} onChange={(e) => onSave(e.target.checked)} aria-label={field.label} aria-describedby={helpId}>
          <span className="text-sm text-primary-text">{value === true ? "Yes" : "No"}</span>
        </Switch>
      );
      break;
    case "date":
      return (
        <RHFDatePickerPopout
          label={field.label}
          required={required}
          hint={help || undefined}
          value={value ?? null}
          valueFormat="iso"
          clearable={!required}
          onChange={(v) => onSave(v || null)}
        />
      );
    case "choice": {
      const options = field.options.filter((o) => o.active || o.key === value).map((o) => ({ value: o.key, label: o.label, hint: o.active ? undefined : "Switched off" }));
      return <ComboField label={field.label} required={required} hint={help || undefined} value={value ?? null} onChange={(v) => onSave(v)} options={options} placeholder="Choose…" />;
    }
    case "person": {
      const options = (people.list ?? []).map((p) => ({ value: p.id, label: p.name }));
      if (value && !options.some((o) => o.value === value)) options.push({ value, label: people.byId[value] ?? "Someone who has left", hint: "No longer a member" });
      return <ComboField label={field.label} required={required} hint={help || undefined} value={value ?? null} onChange={(v) => onSave(v)} options={options} placeholder="Choose a person…" />;
    }
    case "multi_choice": {
      const chosen = Array.isArray(value) ? value : [];
      const shown = field.options.filter((o) => o.active || chosen.includes(o.key));
      control = (
        <div role="group" aria-labelledby={`${id}-label`} aria-describedby={helpId} className="flex flex-wrap gap-1.5">
          {shown.map((o) => {
            const on = chosen.includes(o.key);
            return (
              <button
                key={o.key}
                type="button"
                aria-pressed={on}
                onClick={() => onSave(on ? chosen.filter((k) => k !== o.key) : [...chosen, o.key])}
                className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors ${on ? "border-brand-primary bg-brand-primary/15 text-primary-text" : "border-border-color text-secondary-text hover:border-border-dark-color"}`}>
                {o.label}
              </button>
            );
          })}
        </div>
      );
      break;
    }
    default:
      control = (
        <TextEditor
          id={id}
          field={field}
          value={value}
          onSave={onSave}
          multiline={field.fieldType === "long_text"}
          inputMode={field.fieldType === "number" ? "decimal" : undefined}
          required={required}
          describedBy={helpId}
        />
      );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {field.fieldType === "multi_choice" || field.fieldType === "boolean" ? (
        <span id={`${id}-label`}>{label}</span>
      ) : (
        <label htmlFor={id}>{label}</label>
      )}
      {control}
      {help && (
        <p id={helpId} className="text-xs text-secondary-text">
          {help}
        </p>
      )}
    </div>
  );
};

/**
 * "More details": the organisation's custom fields for one record, grouped by section. Values save as they are given (each field on its own,
 * shown at once and put back if the database refuses). `editable` = the person may edit the record and it is not closed; otherwise the values
 * are shown as words. Retired fields appear only when the record holds a value for them. Renders nothing when the kind of record has no fields.
 */
const CustomFieldsCard = ({ entityType, record, editable = false, title = "More details", className = "" }) => {
  const { data } = useCustomFields(entityType, { includeRetired: true });
  const values = record?.customValues ?? {};
  const fields = (data?.data ?? []).filter((f) => f.active || !isMissing(values[f.key]));
  const stages = data?.entities?.find((e) => e.entityType === entityType)?.stages ?? [];
  const needsPeople = fields.some((f) => f.fieldType === "person");
  const { data: peopleList } = useCustomFieldPeople({ enabled: needsPeople });
  const people = { list: peopleList ?? [], byId: Object.fromEntries((peopleList ?? []).map((p) => [p.id, p.name])) };
  const mutation = useSetCustomValues(entityType, record?.id);
  const { showToast } = useToast();

  if (!record?.id || fields.length === 0) return null;

  const save = (field, value) =>
    mutation.mutate(
      { values: { [field.key]: value }, current: values },
      { onError: (err) => showToast({ type: "error", title: `${field.label} not saved`, message: describeApiError(err) }) },
    );
  const groups = groupBySection(fields);
  const hasSections = groups.some((g) => g.section);

  return (
    <section aria-label={title} className={`flex min-w-0 flex-col gap-4 rounded-2xl border border-border-color bg-secondary-bg p-5 ${className}`}>
      <h2 className="text-lg font-semibold text-primary-text">{title}</h2>
      {groups.map((g) => (
        <div key={g.section || "_"} className="flex flex-col gap-3">
          {hasSections && <h3 className="text-sm font-semibold text-primary-text">{g.section || "Other details"}</h3>}
          <div className="grid gap-4 sm:grid-cols-2">
            {g.fields.map((f) => (
              <div key={f.id} className={f.fieldType === "long_text" || f.fieldType === "multi_choice" ? "sm:col-span-2" : ""}>
                <FieldRow field={f} value={values[f.key]} editable={editable} people={{ ...people, ...people.byId }} stages={stages} onSave={(v) => save(f, v)} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
};

export default CustomFieldsCard;

/**
 * For create forms: the fields that must have a value when the record is saved (or every active field with `all`), held in the form's own state
 * (`values`, `onChange(next)`) and sent as `customValues` with the create. Renders nothing when there are none.
 */
export const CustomFieldInputs = ({ entityType, values = {}, onChange, all = false, title = "More details" }) => {
  const { data } = useCustomFields(entityType);
  const fields = (data?.data ?? []).filter((f) => f.active && (all || f.requiredAt === "save"));
  const stages = data?.entities?.find((e) => e.entityType === entityType)?.stages ?? [];
  const { data: peopleList } = useCustomFieldPeople({ enabled: fields.some((f) => f.fieldType === "person") });
  const byId = Object.fromEntries((peopleList ?? []).map((p) => [p.id, p.name]));
  if (fields.length === 0) return null;
  const set = (field, value) => {
    const next = { ...values };
    if (isMissing(value)) delete next[field.key];
    else next[field.key] = value;
    onChange(next);
  };
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-semibold text-primary-text">{title}</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.id} className={f.fieldType === "long_text" || f.fieldType === "multi_choice" ? "sm:col-span-2" : ""}>
            <FieldRow field={f} value={values[f.key]} editable people={{ list: peopleList ?? [], byId, ...byId }} stages={stages} onSave={(v) => set(f, v)} />
          </div>
        ))}
      </div>
    </fieldset>
  );
};

/** The labels of fields required on save that `values` leaves empty (for a create form's "still needed"). */
export const useMissingRequiredCustomFields = (entityType, values = {}) => {
  const { data } = useCustomFields(entityType);
  return (data?.data ?? []).filter((f) => f.active && f.requiredAt === "save" && isMissing(values[f.key])).map((f) => f.label);
};
