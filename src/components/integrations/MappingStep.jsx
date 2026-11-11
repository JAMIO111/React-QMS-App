import { useState } from "react";
import { ArrowRightIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, CircleAlertIcon, CircleCheckIcon, MinusIcon } from "@/components/icons";
import { DATE_FORMAT_OPTIONS, MATCH_OPTIONS, OWNERSHIP_HINTS, TRANSFORM_OPTIONS, ownershipOptions, rowHasSource } from "../../lib/integrations";
import SlidingToggle from "../ui/SlidingToggle";
import FormulaEditor from "./FormulaEditor";
import StepEditor from "./StepEditor";
import Switch from "../ui/Switch";
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

/**
 * The words the editor uses for where values come from: a file has columns and cells, an API sends records whose fields (nested ones with dots) are the
 * columns. The data is the same shape either way; only the wording differs.
 */
const SOURCE_WORDS = {
  file: {
    column: "column", columns: "columns", Column: "Column", cell: "cell", header: "Column in your file",
    keyLabel: "Column that identifies each record", keyHint: "The same record keeps the same value in every file, so importing again updates it instead of adding another",
    missingTitle: "Columns the mapping uses are not in this file", unused: (n) => (n === 1 ? "1 column of the file is not used" : `${n} columns of the file are not used`),
    translate: "Translate (one per line: value in the file=value in Fortress)", matchSource: "The id it was given when it was imported from this file source",
  },
  api: {
    column: "field", columns: "fields", Column: "API field", cell: "field", header: "Field the API sends",
    keyLabel: "Field that identifies each record", keyHint: "The same record keeps the same value every time it is read, so importing again updates it instead of adding another",
    missingTitle: "Fields the mapping uses are not in what the API sends", unused: (n) => (n === 1 ? "1 field the API sends is not used" : `${n} fields the API sends are not used`),
    translate: "Translate (one per line: value the API sends=value in Fortress)", matchSource: "The id it was given when it was imported through this connection",
  },
};

/** What goes in the middle of a row when it is not a single column. */
const SourceSummary = ({ row, words }) => (
  <span className="block truncate rounded-lg border border-dashed border-border-color px-2 py-2 text-sm text-secondary-text" title={row.useFormula ? row.formula : undefined}>
    {row.useFormula ? <span className="font-mono">{row.formula || "No formula yet"}</span> : row.transform === "constant" ? `Always "${row.value}"` : `${row.sources.join(" + ") || `No ${words.columns} yet`}`}
  </span>
);

/** The settings under a row: how the value is cleaned, what to use when the cell is empty, dates, decimals and how a link is matched. */
const RowSettings = ({ field, row, set, colOptions, readOnly, advanced, example, sample, updates, words }) => (
  <div className="flex flex-col gap-3 border-t border-border-color px-3 pb-3 pt-3 sm:pl-11">
    {(advanced || row.useFormula) && (
      <Switch checked={!!row.useFormula} onChange={(e) => set({ useFormula: e.target.checked })} disabled={readOnly || (!advanced && row.useFormula)}>Use a formula instead of a {words.column}</Switch>
    )}
    {row.useFormula ? (
      <FormulaEditor value={row.formula ?? ""} onChange={(formula) => set({ formula })} columns={colOptions.map((o) => o.value)} sample={sample} readOnly={readOnly || !advanced} label={`Formula for ${field.label}`} />
    ) : (
      <LegacySettings field={field} row={row} set={set} colOptions={colOptions} readOnly={readOnly} words={words} />
    )}
    {field.ref?.source && row.useFormula && (
      <ComboField label="Match by" value={row.match} onChange={(v) => set({ match: v ?? "code" })} options={MATCH_OPTIONS} required disabled={readOnly} />
    )}
    <StepEditor steps={row.steps ?? []} onChange={(steps) => set({ steps })} columns={colOptions.map((o) => o.value)} after={example?.steps ?? []} error={example?.stepError ?? null} readOnly={readOnly} label={`Steps for ${field.label}`} />
    {updates && <OwnershipChoice field={field} row={row} set={set} readOnly={readOnly} />}
  </div>
);

/** What a later import may do to this field once the record exists (only when the import updates records). */
const OwnershipChoice = ({ field, row, set, readOnly }) => {
  const value = row.ownership ?? "source_wins";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-secondary-text">When the record is already in Fortress</span>
      <SlidingToggle
        ariaLabel={`Who owns ${field.label}`}
        options={ownershipOptions(field).map((o) => ({ ...o, disabled: readOnly }))}
        value={value}
        onChange={(v) => set({ ownership: v })}
      />
      <span className="text-xs text-secondary-text">{OWNERSHIP_HINTS[value]}</span>
    </div>
  );
};

/** How the original transforms read a column (kept for mappings made before steps and formulas). */
const LegacySettings = ({ field, row, set, colOptions, readOnly, words }) => (
  <div className="flex flex-col gap-3">
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
            label={`Add a ${words.column}`}
            value={null}
            onChange={(v) => v && set({ sources: [...row.sources, v] })}
            options={colOptions.filter((o) => !row.sources.includes(o.value))}
            disabled={readOnly}
          />
          <Field label="Put between them" value={row.separator} onChange={(e) => set({ separator: e.target.value })} disabled={readOnly} />
        </>
      )}
      {row.transform !== "constant" && row.transform !== "concat" && (
        <Field label={`When the ${words.cell} is empty, use`} value={row.default} onChange={(e) => set({ default: e.target.value })} disabled={readOnly} />
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
          hint={row.match === "source" ? words.matchSource : "The code as it is in Fortress"}
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
        label={words.translate}
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
const MappingRow = ({ field, row, onChange, colOptions, preview, sample, readOnly, advanced, updates, words }) => {
  const [open, setOpen] = useState(false);
  const set = (patch) => onChange({ ...row, ...patch });
  const matched = rowHasSource(row);
  const missing = field.required && !matched;
  // What the server makes of this field on the example row (T3): taken value, after each step, the imported value or the error.
  const p = preview?.fields?.find((f) => f.target === field.key) ?? null;
  const stepError = p?.error && p.taken !== null && (row.steps?.length ?? 0) > (p.steps?.length ?? 0) ? p.error : null;
  const example = p ? { value: p.value === null || p.value === undefined ? p.taken ?? "" : String(p.value), problem: p.error, steps: p.steps, stepError } : { value: "", problem: null };
  const simple = !row.useFormula && row.transform !== "constant" && row.transform !== "concat";
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
              {[field.custom ? "custom field" : null, TYPE_HINTS[field.type], field.ref ? "link to another record" : null, row.useFormula ? "formula" : row.transform !== "none" ? TRANSFORM_OPTIONS.find((t) => t.value === row.transform)?.label.toLowerCase() : null, row.steps?.length ? `${row.steps.length} step${row.steps.length === 1 ? "" : "s"}` : null, updates && row.ownership === "qms_wins" ? "Fortress wins" : null, updates && row.ownership === "manual_review" ? "changes reviewed" : null].filter(Boolean).join(" · ") || "text"}
            </span>
          </div>
        </div>
        <ArrowRightIcon className="hidden text-tertiary-text sm:block" aria-hidden="true" />
        <div className="col-span-2 min-w-0 sm:col-span-1">
          {simple ? (
            <ComboField
              ariaLabel={`${words.Column} for ${field.label}`}
              value={row.source}
              onChange={(v) => set({ source: v })}
              options={colOptions}
              placeholder={field.required ? `Choose a ${words.column}` : "Not imported"}
              disabled={readOnly}
              error={missing && !row.source ? true : undefined}
              clearable
            />
          ) : (
            <SourceSummary row={row} words={words} />
          )}
        </div>
        <span className="hidden text-tertiary-text sm:block" aria-hidden="true">=</span>
        <div className="col-span-2 min-w-0 sm:col-span-1" aria-label={`Example for ${field.label}`}>
          <span
            title={example.problem ?? example.value}
            className={`block truncate rounded-lg px-2 py-1.5 text-sm ${example.problem ? "bg-error-color/10 text-error-color" : example.value ? "bg-secondary-bg text-primary-text" : "bg-secondary-bg text-tertiary-text"}`}>
            {!matched ? "—" : !p ? "…" : example.problem ? `${example.value ? `${example.value} · ` : ""}${example.problem}` : example.value || "(empty)"}
          </span>
        </div>
      </div>
      {open && (
        <div id={settingsId}>
          <RowSettings field={field} row={row} set={set} colOptions={colOptions} readOnly={readOnly} advanced={advanced} example={example} sample={sample} updates={updates} words={words} />
        </div>
      )}
    </li>
  );
};

/**
 * Reusable mapping editor: one row per Fortress field — field → column of the source = what the chosen record becomes. A row opens to show how the
 * value is cleaned. Required fields with no source are shown in red and counted in the banner. The caller keeps `rows` and `keyField`.
 */
const MappingStep = ({ fields, columns, sample = [], preview = null, previewing = false, keyField, onKeyField, rows, onRows, readOnly = false, advanced = false, problems = [], updates = false, source = "file" }) => {
  const words = SOURCE_WORDS[source] ?? SOURCE_WORDS.file;
  const [at, setAt] = useState(0);
  const colOptions = columns.map((c) => ({ value: c, label: c }));
  const previewRows = preview?.rows ?? [];
  const here = previewRows[Math.min(at, Math.max(0, previewRows.length - 1))] ?? null;
  const values = (here ? sample.find((s) => s.row === here.row)?.values : sample[at]?.values) ?? null;
  const check = preview?.columnCheck;
  const missing = fields.filter((f, i) => f.required && !rowHasSource(rows[i]));
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ComboField
          label={words.keyLabel}
          value={keyField}
          onChange={onKeyField}
          options={colOptions}
          hint={words.keyHint}
          required
          disabled={readOnly}
        />
        {previewRows.length > 0 && (
          <div className="flex items-end justify-end gap-2 text-sm text-secondary-text">
            <span aria-live="polite">{previewing ? "Working it out…" : `Examples from row ${here?.row}`}{here?.errors?.length ? ` · ${here.errors.length} problem${here.errors.length === 1 ? "" : "s"}` : ""}</span>
            <button type="button" aria-label="Previous row" disabled={at === 0} onClick={() => setAt((a) => a - 1)} className="rounded-lg p-1.5 hover:bg-border-color disabled:opacity-40"><ChevronLeftIcon /></button>
            <button type="button" aria-label="Next row" disabled={at >= previewRows.length - 1} onClick={() => setAt((a) => a + 1)} className="rounded-lg p-1.5 hover:bg-border-color disabled:opacity-40"><ChevronRightIcon /></button>
          </div>
        )}
      </div>
      {missing.length > 0 && (
        <Callout tone="error" title={missing.length === 1 ? "1 required field is not matched" : `${missing.length} required fields are not matched`}>
          Choose a {words.column} for {missing.map((f) => f.label).join(", ")}, or open the row to give a fixed value.
        </Callout>
      )}
      {check?.missing?.length > 0 && (
        <Callout tone={check.missing.some((m) => m.blocking) ? "error" : "warning"} title={words.missingTitle}>
          <ul className="list-disc pl-5">
            {check.missing.map((m) => <li key={m.column}>[{m.column}] — {m.fields.join(", ")}{m.blocking ? " (needed)" : ""}</li>)}
          </ul>
        </Callout>
      )}
      {check?.unused?.length > 0 && (
        <Callout tone="info" title={words.unused(check.unused.length)}>
          {check.unused.join(", ")}
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
        <span>{words.header}</span>
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
            preview={here}
            sample={values}
            readOnly={readOnly}
            advanced={advanced}
            updates={updates}
            words={words}
            onChange={(row) => onRows(rows.map((r, j) => (j === i ? row : r)))}
          />
        ))}
      </ul>
    </div>
  );
};

export default MappingStep;
