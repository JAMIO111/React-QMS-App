import { useEffect, useState } from "react";
import { XIcon } from "@/components/icons";
import { useCustomFieldPeople, useCustomFields } from "../../hooks/useCustomFields";
import ComboField from "../ui/ComboField";
import { describeCustomFilter, useCustomFilterParams } from "./customColumns";

const inputClass = "w-full rounded-lg border border-border-color bg-text-input-color px-3 py-1.5 text-sm text-primary-text outline-none focus:border-brand-primary";

/** A text box that applies its value after a pause (filters re-query the register). */
const DebouncedInput = ({ value, onChange, ...rest }) => {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  useEffect(() => {
    if (text === (value ?? "")) return undefined;
    const t = setTimeout(() => onChange(text.trim()), 400);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return <input {...rest} value={text} onChange={(e) => setText(e.target.value)} className={inputClass} />;
};

const splitRange = (v) => {
  const m = /^(.*)\.\.(.*)$/.exec(v ?? "");
  return m ? [m[1], m[2]] : [v ?? "", v ?? ""];
};

/**
 * Filters on the kind of record's custom fields for a register's filter drawer, kept in the address as `cf_<key>` (the register's list hook
 * sends them to the API). Text contains; one or several choices / people any of; yes / no; number and date from–to. Renders nothing without fields.
 */
const CustomFieldFilters = ({ entityType, title = "More details" }) => {
  const { data } = useCustomFields(entityType);
  const fields = (data?.data ?? []).filter((f) => f.active);
  const { params, set } = useCustomFilterParams();
  const { data: people } = useCustomFieldPeople({ enabled: fields.some((f) => f.fieldType === "person") });
  if (fields.length === 0) return null;

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-semibold text-primary-text">{title}</legend>
      {fields.map((f) => {
        const value = params[`cf_${f.key}`] ?? "";
        const id = `cf-filter-${f.key}`;
        switch (f.fieldType) {
          case "choice":
          case "multi_choice":
          case "person": {
            const options = f.fieldType === "person" ? (people ?? []).map((p) => ({ value: p.id, label: p.name })) : f.options.map((o) => ({ value: o.key, label: o.label }));
            return <ComboField key={f.key} label={f.label} value={value.split(",")[0] || null} onChange={(v) => set(f.key, v ?? "")} options={[{ value: "-", label: "No value" }, ...options]} placeholder="Any" clearable />;
          }
          case "boolean":
            return (
              <ComboField key={f.key} label={f.label} value={value || null} onChange={(v) => set(f.key, v ?? "")} options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} placeholder="Any" clearable />
            );
          case "number":
          case "date": {
            const [lo, hi] = splitRange(value);
            const apply = (a, b) => set(f.key, a || b ? (a === b && a ? a : `${a}..${b}`) : "");
            const type = f.fieldType === "date" ? "date" : "text";
            return (
              <div key={f.key} className="flex flex-col gap-1">
                <span className="text-sm font-medium text-secondary-text">
                  {f.label}
                  {f.unit ? ` (${f.unit})` : ""}
                </span>
                <div className="flex items-center gap-2">
                  <DebouncedInput type={type} inputMode={f.fieldType === "number" ? "decimal" : undefined} aria-label={`${f.label} from`} placeholder="From" value={lo} onChange={(v) => apply(v, hi)} />
                  <span className="text-xs text-secondary-text">to</span>
                  <DebouncedInput type={type} inputMode={f.fieldType === "number" ? "decimal" : undefined} aria-label={`${f.label} to`} placeholder="To" value={hi} onChange={(v) => apply(lo, v)} />
                </div>
              </div>
            );
          }
          default:
            return (
              <div key={f.key} className="flex flex-col gap-1">
                <label htmlFor={id} className="text-sm font-medium text-secondary-text">
                  {f.label}
                </label>
                <DebouncedInput id={id} placeholder="Contains…" value={value} onChange={(v) => set(f.key, v)} />
              </div>
            );
        }
      })}
    </fieldset>
  );
};

/** Removable chips for the active custom field filters (beside a register's other filter chips). */
export const CustomFilterChips = ({ entityType }) => {
  const { data } = useCustomFields(entityType);
  const { params, set } = useCustomFilterParams();
  const fields = data?.data ?? [];
  const { data: people } = useCustomFieldPeople({ enabled: fields.some((f) => f.fieldType === "person") });
  const byId = Object.fromEntries((people ?? []).map((p) => [p.id, p.name]));
  const active = Object.entries(params)
    .map(([k, v]) => ({ field: fields.find((f) => `cf_${f.key}` === k), value: v }))
    .filter((a) => a.field);
  if (active.length === 0) return null;
  return active.map(({ field, value }) => {
    const text = describeCustomFilter(field, value, byId);
    return (
      <span key={field.key} className="inline-flex items-center gap-1 rounded-full border border-border-color bg-secondary-bg px-2.5 py-0.5 text-xs text-primary-text">
        {text}
        <button type="button" aria-label={`Remove filter ${text}`} className="cursor-pointer text-secondary-text hover:text-primary-text" onClick={() => set(field.key, "")}>
          <XIcon />
        </button>
      </span>
    );
  });
};

export default CustomFieldFilters;
