import { useState } from "react";
import { PlusIcon, Trash2Icon } from "@/components/icons";
import {
  DECIMAL_MARKS,
  FILTER_DATE_FORMATS,
  FILTER_MATCH,
  FILTER_MODES,
  FILTER_READ_AS,
  FILTER_TESTS,
  MAX_FILTER_RULES,
  cleanFilter,
  filterColumns,
  filterWords,
  newFilter,
  newRule,
  testInfo,
  withRule,
} from "../../lib/importFilters";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Field from "../ui/Field";
import SlidingToggle from "../ui/SlidingToggle";
import Switch from "../ui/Switch";
import { TextAreaField } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";

const TEST_OPTIONS = FILTER_TESTS.map((t) => ({ value: t.value, label: t.label }));

/** One rule: a column, a test and what to compare with. */
const RuleRow = ({ rule, index, columns, onChange, onRemove, readOnly, canRemove }) => {
  const info = testInfo(rule.test);
  const colOptions = [...new Set([...columns, ...(rule.column && !columns.includes(rule.column) ? [rule.column] : [])])].map((c) => ({ value: c, label: c, hint: columns.includes(c) ? undefined : "Not in this source" }));
  const n = index + 1;
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border-color bg-primary-bg p-3" aria-label={`Rule ${n}`}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] md:items-end">
        <ComboField label="Column" value={rule.column || null} onChange={(v) => onChange({ column: v ?? "" })} options={colOptions} required disabled={readOnly} />
        <ComboField label="Test" value={rule.test} onChange={(v) => onChange({ test: v ?? "equals" })} options={TEST_OPTIONS} required disabled={readOnly} />
        {info.needs === "one" && <Field aria-label={`Value for rule ${n}`} label="Value" value={rule.value ?? ""} onChange={(e) => onChange({ value: e.target.value })} maxLength={500} required disabled={readOnly} />}
        {info.needs === "two" && (
          <div className="grid grid-cols-2 gap-2">
            <Field aria-label={`From for rule ${n}`} label="From" value={rule.value ?? ""} onChange={(e) => onChange({ value: e.target.value })} maxLength={500} required disabled={readOnly} />
            <Field aria-label={`To for rule ${n}`} label="To" value={rule.valueTo ?? ""} onChange={(e) => onChange({ valueTo: e.target.value })} maxLength={500} required disabled={readOnly} />
          </div>
        )}
        {(info.needs === "none" || info.needs === "list") && <div className="hidden md:block" />}
        <div className="flex md:pb-0.5">
          {!readOnly && canRemove && (
            <CTAButton type="neutral" size="md" aria-label={`Remove rule ${n}`} icon={Trash2Icon} onClick={onRemove} />
          )}
        </div>
      </div>
      {info.needs === "list" && (
        <TextAreaField
          label="Values (one per line)"
          value={(rule.values ?? []).join("\n")}
          onChange={(e) => onChange({ values: e.target.value.split("\n") })}
          rows={3}
          disabled={readOnly}
          required
        />
      )}
      {info.ordered && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ComboField label="Read the column as" value={rule.as ?? "text"} onChange={(v) => onChange({ as: v ?? "text" })} options={FILTER_READ_AS} disabled={readOnly} hint="Numbers and dates are compared in order, text alphabetically" />
          {rule.as === "number" && <ComboField label="Decimal mark" value={rule.decimal ?? "."} onChange={(v) => onChange({ decimal: v ?? "." })} options={DECIMAL_MARKS} disabled={readOnly} />}
          {rule.as === "date" && <ComboField label="Dates are written like" value={rule.dateFormat ?? "iso"} onChange={(v) => onChange({ dateFormat: v ?? "iso" })} options={FILTER_DATE_FORMATS} disabled={readOnly} />}
        </div>
      )}
    </li>
  );
};

/** A table of a few records: the columns the filter reads first. */
const SampleTable = ({ title, rows, columns, empty }) => (
  <div className="flex min-w-0 flex-col gap-1">
    <h4 className="text-sm font-semibold text-primary-text">{title}</h4>
    {rows.length === 0 ? (
      <p className="text-sm text-secondary-text">{empty}</p>
    ) : (
      <div className="overflow-x-auto rounded-lg border border-border-color">
        <table className="min-w-full text-left text-xs" aria-label={title}>
          <thead className="bg-primary-bg">
            <tr>
              <th className="px-2 py-1.5 text-secondary-text">Row</th>
              {columns.map((c) => <th key={c} className="whitespace-nowrap px-2 py-1.5 text-secondary-text">{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.row} className="border-t border-border-color">
                <td className="px-2 py-1.5 text-secondary-text">{r.row}</td>
                {columns.map((c) => <td key={c} className="max-w-[14rem] truncate whitespace-nowrap px-2 py-1.5 text-primary-text">{r.values?.[c]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
);

/** What the server worked out for the filter on screen: counts, per-rule counts, problems and a few records of each kind. */
export const FilterResult = ({ preview, previewing, filter, total }) => {
  const f = cleanFilter(filter);
  if (!f) {
    return (
      <div className="rounded-xl border border-border-color bg-primary-bg p-3 text-sm text-secondary-text" role="status">
        No filter: every record{total != null ? ` (${total})` : ""} is read.
      </div>
    );
  }
  if (!preview) return <p className="text-sm text-secondary-text" role="status">{previewing ? "Checking the filter…" : "Working out what the filter does…"}</p>;
  const columns = [...new Set([...filterColumns(f), ...preview.columns])].slice(0, 8);
  const share = preview.scanned ? Math.round((preview.kept / preview.scanned) * 100) : 0;
  return (
    <div className="flex flex-col gap-3" aria-busy={previewing || undefined}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-xl border border-border-color bg-primary-bg p-3" role="status">
        <span className="text-2xl font-semibold text-primary-text">{preview.kept} <span className="text-base font-normal text-secondary-text">of {preview.scanned} records kept</span></span>
        <span className="text-sm text-secondary-text">{preview.leftOut} left out · {share}% read{previewing ? " · updating…" : ""}</span>
        <span className="basis-full text-xs text-secondary-text">
          {preview.complete ? "Counted over every row of the file." : `Counted over the first ${preview.scanned} records the source sent, not all of them.`}
        </span>
      </div>
      {preview.problems.length > 0 && (
        <Callout tone="error" title="This filter cannot be used yet">
          <ul className="list-disc pl-5">{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Callout>
      )}
      {preview.errors.count > 0 && (
        <Callout tone="warning" title={`${preview.errors.count} ${preview.errors.count === 1 ? "record" : "records"} could not be checked`}>
          Their rows would be rejected, not skipped{preview.errors.first ? `: ${preview.errors.first}` : "."}
        </Callout>
      )}
      {preview.problems.length === 0 && preview.scanned > 0 && preview.kept === 0 && (
        <Callout tone="warning" title="This filter keeps nothing">An import would read no records. Check the rules below.</Callout>
      )}
      {preview.rules.length > 1 && (
        <ul className="flex flex-col gap-1 text-sm text-secondary-text" aria-label="Records each rule matches">
          {preview.rules.map((r) => <li key={r.words}><span className="font-medium text-primary-text">{r.matched}</span> {r.matched === 1 ? "record matches" : "records match"}: {r.words}</li>)}
        </ul>
      )}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <SampleTable title="Some records that are read" rows={preview.samples.kept} columns={columns} empty="No record is read." />
        <SampleTable title="Some records that are skipped" rows={preview.samples.leftOut} columns={columns} empty="No record is skipped." />
      </div>
    </div>
  );
};

/**
 * The rule builder for an import's record filter (docs/import-filters-plan.md, F2): pick whether to read only matching records or all but those, then
 * one or more rules (a column, a test and a value, combined with all or any) or, with advanced imports on, one formula. `value` is the on-screen draft
 * (rules may be half typed); `cleanFilter` is what is saved and sent. The result under it comes from the server, so the counts are exactly what the
 * import will do.
 */
const FilterBuilder = ({ columns, value, onChange, preview, previewing, total, readOnly = false, advanced = false }) => {
  const filter = value ?? null;
  const [useFormula, setUseFormula] = useState(!!filter?.formula);
  const active = !!filter && (filter.formula !== undefined || (filter.rules ?? []).length > 0);
  const set = (next) => onChange(next);
  const start = () => set(newFilter());
  const rules = filter?.rules ?? [];

  if (!active && !useFormula) {
    return (
      <div className="flex flex-col gap-3">
        <FilterResult preview={null} filter={null} total={total} />
        {!readOnly && (
          <div>
            <CTAButton type="secondary" size="md" icon={PlusIcon} onClick={start}>Add a filter</CTAButton>
          </div>
        )}
      </div>
    );
  }

  const f = filter ?? newFilter();
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <ComboField label="What to read" value={f.mode} onChange={(v) => set({ ...f, mode: v ?? "keep" })} options={FILTER_MODES} required disabled={readOnly} />
        {!useFormula && rules.length > 1 && (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-secondary-text">A record matches when it meets</span>
            <SlidingToggle ariaLabel="How the rules combine" options={FILTER_MATCH} value={f.match} onChange={(v) => set({ ...f, match: v })} />
          </div>
        )}
      </div>

      {useFormula ? (
        <TextAreaField
          label="Formula (true means the record matches)"
          value={f.formula ?? ""}
          onChange={(e) => set({ ...f, formula: e.target.value, rules: [] })}
          rows={3}
          maxLength={2000}
          disabled={readOnly}
          hint='Write a column in square brackets, for example [Status]="Active" AND [Qty]>0. Columns are read as the file or API gives them.'
        />
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Filter rules">
          {rules.map((rule, i) => (
            <RuleRow
              key={i}
              rule={rule}
              index={i}
              columns={columns}
              readOnly={readOnly}
              canRemove={rules.length > 1}
              onChange={(change) => set(withRule(f, i, change))}
              onRemove={() => set({ ...f, rules: rules.filter((_, j) => j !== i) })}
            />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {!useFormula && !readOnly && rules.length < MAX_FILTER_RULES && (
          <CTAButton type="secondary" size="md" icon={PlusIcon} onClick={() => set({ ...f, rules: [...rules, newRule()] })}>Add a rule</CTAButton>
        )}
        {advanced && (
          <Switch
            checked={useFormula}
            disabled={readOnly}
            onChange={(e) => {
              setUseFormula(e.target.checked);
              set(e.target.checked ? { ...f, rules: [], formula: "" } : { mode: f.mode, match: f.match, rules: [newRule()] });
            }}>
            Use a formula instead of rules
          </Switch>
        )}
        {!readOnly && (
          <CTAButton
            type="neutral"
            size="md"
            onClick={() => {
              setUseFormula(false);
              set(null);
            }}>
            Remove the filter
          </CTAButton>
        )}
      </div>

      <p className="text-sm text-secondary-text" role="status">{filterWords(f)}</p>
      <FilterResult preview={preview} previewing={previewing} filter={f} total={total} />
    </div>
  );
};

export default FilterBuilder;
