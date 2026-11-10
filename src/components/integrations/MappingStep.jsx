import { useState } from "react";
import { ArrowRightIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, CircleAlertIcon, CircleCheckIcon, MinusIcon } from "@/components/icons";
import { DATE_FORMAT_OPTIONS, MATCH_OPTIONS, TRANSFORM_OPTIONS, exampleValue, rowHasSource } from "../../lib/integrations";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Field from "../ui/Field";
import { TextAreaField } from "../master-data/shared";

const TYPE_HINTS = { date: "date", number: "number", integer: "whole number", boolean: "yes / no", email: "email", url: "web address", enum: "one of a list", country: "country code" };

/** The limits the database sets for a field, in words ("Up to 20 characters", "From 1 to 1000"). */
const fieldLimits = (f) => {
  if (f.ref) return null;
  if ((f.type === "number" || f.type === "integer") && (f.min != null || f.max != null)) {
    if (f.min != null && f.max != null) return `From ${f.min} to ${f.max}`;
    if (f.min == null) return `At most ${f.max}`;
    return f.minExclusive ? `More than ${f.min}` : `At least ${f.min}`;
  }
  return f.maxLength ? `Up to ${f.maxLength} characters` : null;
};

/** What goes in the middle of a row when it is not a single column. */
const SourceSummary = ({ row }) => (
  <span className="block truncate rounded-lg border border-dashed border-border-color px-2 py-1.5 text-sm text-secondary-text">
    {row.transform === "constant" ? `Always "${row.value}"` : `${row.sources.join(" + ") || "No columns yet"}`}
  </span>
);

/** The settings under a row: how the value is cleaned, what to use when the cell is empty, dates, decimals and how a link is matched. */
const RowSettings = ({ field, row, set, colOptions, readOnly }) => (
  <div className="flex flex-col gap-3 border-t border-border-color px-3 pb-3 pt-3 sm:pl-11">
    {(field.description || field.options || fieldLimits(field)) && (
      <div className="flex flex-col gap-0.5 text-xs text-secondary-text">
        {field.description && <span>{field.description}</span>}
        {field.options && <span>Accepted values: {field.options.map((o) => o.label).join(", ")}</span>}
        {fieldLimits(field) && <span>{fieldLimits(field)}</span>}
      </div>
    )}
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <ComboField label="How" value={row.transform} onChange={(v) => set({ transform: v ?? "none" })} options={TRANSFORM_OPTIONS} required disabled={readOnly} />
      {row.transform === "constant" && <Field label="Fixed value" value={row.value} onChange={(e) => set({ value: e.target.value })} required disabled={readOnly} />}
      {row.transform === "concat" && (
        <>
          <ComboField
            label="Add a column"
            value={null}
            onChange={(v) => v && set({ sources: [...row.sources, v] })}
            options={colOptions.filter((o) => !row.sources.includes(o.value))}
            disabled={readOnly}
          />
          <Field label="Put between them" value={row.separator} onChange={(e) => set({ separator: e.target.value })} disabled={readOnly} />
        </>
      )}
      {row.transform !== "constant" && row.transform !== "concat" && (
        <Field label="When the cell is empty, use" value={row.default} onChange={(e) => set({ default: e.target.value })} disabled={readOnly} />
      )}
      {field.type === "date" && row.transform !== "constant" && (
        <ComboField label="Dates written as" value={row.dateFormat} onChange={(v) => set({ dateFormat: v ?? "iso" })} options={DATE_FORMAT_OPTIONS} required disabled={readOnly} />
      )}
      {(field.type === "number" || field.type === "integer") && row.transform !== "constant" && (
        <ComboField label="Decimal mark" value={row.decimal} onChange={(v) => set({ decimal: v ?? "." })} options={[{ value: ".", label: "Point (1.5)" }, { value: ",", label: "Comma (1,5)" }]} required disabled={readOnly} />
      )}
      {field.ref?.source && row.transform !== "constant" && row.transform !== "concat" && (
        <ComboField
          label="Match by"
          value={row.match}
          onChange={(v) => set({ match: v ?? "code" })}
          options={MATCH_OPTIONS}
          hint={row.match === "source" ? "The id it was given when it was imported from this file source" : "The code as it is in Fortress"}
          required
          disabled={readOnly}
        />
      )}
    </div>
    {row.transform === "concat" && row.sources.length > 0 && (
      <div className="flex flex-wrap items-center gap-1">
        {row.sources.map((s) => (
          <span key={s} className="inline-flex items-center gap-1 rounded-full bg-border-color px-2 py-0.5 text-xs text-primary-text">
            {s}
            {!readOnly && <button type="button" aria-label={`Remove ${s}`} onClick={() => set({ sources: row.sources.filter((x) => x !== s) })}>×</button>}
          </span>
        ))}
      </div>
    )}
    {row.transform === "map" && (
      <TextAreaField
        label="Translate (one per line: value in the file=value in Fortress)"
        value={row.valuesText}
        onChange={(e) => set({ valuesText: e.target.value })}
        rows={3}
        required
        disabled={readOnly}
      />
    )}
  </div>
);

/** One Fortress field: where its value comes from, what the chosen record makes of it, and (opened) how it is cleaned. */
const MappingRow = ({ field, row, onChange, colOptions, values, readOnly }) => {
  const [open, setOpen] = useState(false);
  const set = (patch) => onChange({ ...row, ...patch });
  const matched = rowHasSource(row);
  const missing = field.required && !matched;
  const example = matched ? exampleValue(row, field, values) : { value: "", problem: null };
  const simple = row.transform !== "constant" && row.transform !== "concat";
  const settingsId = `map-settings-${field.key}`;
  return (
    <li
      aria-label={field.label}
      data-missing={missing || undefined}
      className={`rounded-xl border ${missing ? "border-error-color bg-error-color/5" : "border-border-color bg-primary-bg"}`}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-2 p-2 sm:grid-cols-[auto_minmax(0,1.1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={settingsId}
          aria-label={`${open ? "Hide" : "Show"} settings for ${field.label}`}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary-text hover:bg-border-color">
          {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </button>
        <div className="flex min-w-0 items-center gap-2">
          {missing ? (
            <CircleAlertIcon className="shrink-0 text-error-color" aria-label="Not matched" />
          ) : matched ? (
            <CircleCheckIcon className="shrink-0 text-success-color" aria-label="Matched" />
          ) : (
            <MinusIcon className="shrink-0 text-tertiary-text" aria-label="Not imported" />
          )}
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-primary-text" data-required={field.required || undefined}>{field.label}</span>
            <span className="truncate text-xs text-secondary-text">
              {[TYPE_HINTS[field.type], field.ref ? "link to another record" : null, row.transform !== "none" ? TRANSFORM_OPTIONS.find((t) => t.value === row.transform)?.label.toLowerCase() : null].filter(Boolean).join(" · ") || "text"}
            </span>
          </div>
        </div>
        <ArrowRightIcon className="hidden text-tertiary-text sm:block" aria-hidden="true" />
        <div className="col-span-2 min-w-0 sm:col-span-1">
          {simple ? (
            <ComboField
              ariaLabel={`Column for ${field.label}`}
              value={row.source}
              onChange={(v) => set({ source: v })}
              options={colOptions}
              placeholder={field.required ? "Choose a column" : "Not imported"}
              disabled={readOnly}
              error={missing && !row.source ? true : undefined}
              clearable
            />
          ) : (
            <SourceSummary row={row} />
          )}
        </div>
        <span className="hidden text-tertiary-text sm:block" aria-hidden="true">=</span>
        <div className="col-span-2 min-w-0 sm:col-span-1" aria-label={`Example for ${field.label}`}>
          <span
            title={example.problem ?? example.value}
            className={`block truncate rounded-lg px-2 py-1.5 text-sm ${example.problem ? "bg-error-color/10 text-error-color" : example.value ? "bg-secondary-bg text-primary-text" : "bg-secondary-bg text-tertiary-text"}`}>
            {example.problem ? `${example.value} · ${example.problem}` : example.value || (matched ? "(empty)" : "—")}
          </span>
        </div>
      </div>
      {open && (
        <div id={settingsId}>
          <RowSettings field={field} row={row} set={set} colOptions={colOptions} readOnly={readOnly} />
        </div>
      )}
    </li>
  );
};

/**
 * Reusable mapping editor: one row per Fortress field — field → column of the source = what the chosen record becomes. A row opens to show how the
 * value is cleaned. Required fields with no source are shown in red and counted in the banner. The caller keeps `rows` and `keyField`.
 */
const MappingStep = ({ fields, columns, sample = [], keyField, onKeyField, rows, onRows, readOnly = false, problems = [] }) => {
  const [at, setAt] = useState(0);
  const colOptions = columns.map((c) => ({ value: c, label: c }));
  const values = sample[at]?.values ?? null;
  const missing = fields.filter((f, i) => f.required && !rowHasSource(rows[i]));
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ComboField
          label="Column that identifies each record"
          value={keyField}
          onChange={onKeyField}
          options={colOptions}
          hint="The same record keeps the same value in every file, so importing again updates it instead of adding another"
          required
          disabled={readOnly}
        />
        {sample.length > 0 && (
          <div className="flex items-end justify-end gap-2 text-sm text-secondary-text">
            <span>Examples from row {sample[at].row}</span>
            <button type="button" aria-label="Previous row" disabled={at === 0} onClick={() => setAt((a) => a - 1)} className="rounded-lg p-1.5 hover:bg-border-color disabled:opacity-40"><ChevronLeftIcon /></button>
            <button type="button" aria-label="Next row" disabled={at >= sample.length - 1} onClick={() => setAt((a) => a + 1)} className="rounded-lg p-1.5 hover:bg-border-color disabled:opacity-40"><ChevronRightIcon /></button>
          </div>
        )}
      </div>
      {missing.length > 0 && (
        <Callout tone="error" title={missing.length === 1 ? "1 required field is not matched" : `${missing.length} required fields are not matched`}>
          Choose a column for {missing.map((f) => f.label).join(", ")}, or open the row to give a fixed value.
        </Callout>
      )}
      {problems.length > 0 && (
        <Callout tone="error" title="The mapping was not saved">
          <ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Callout>
      )}
      <div className="hidden grid-cols-[2rem_minmax(0,1.1fr)_1rem_minmax(0,1fr)_1rem_minmax(0,1fr)] gap-x-2 px-2 text-xs font-medium uppercase tracking-wide text-tertiary-text sm:grid">
        <span />
        <span>Fortress field</span>
        <span />
        <span>Column in your file</span>
        <span />
        <span>Example</span>
      </div>
      <ul aria-label="Fields" className="flex flex-col gap-2">
        {fields.map((f, i) => (
          <MappingRow
            key={f.key}
            field={f}
            row={rows[i]}
            colOptions={colOptions}
            values={values}
            readOnly={readOnly}
            onChange={(row) => onRows(rows.map((r, j) => (j === i ? row : r)))}
          />
        ))}
      </ul>
    </div>
  );
};

export default MappingStep;
