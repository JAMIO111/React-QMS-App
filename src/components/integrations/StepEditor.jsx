import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "@/components/icons";
import { formatValueMap, parseValueMap } from "../../lib/integrations";
import { STEP_BY_KIND, STEP_DATE_FORMATS, STEP_OPTIONS, describeStep, newStep, stepProblem } from "../../lib/importTemplates";
import ComboField from "../ui/ComboField";
import Field from "../ui/Field";
import Switch from "../ui/Switch";
import { TextAreaField } from "../master-data/shared";

const KNOWN_DATE = ["iso", "dmy", "mdy", "excel"];

/** The pieces of a "join" step: the value itself, a column or some text, in order. */
const PartsEditor = ({ parts, onChange, columns, readOnly }) => (
  <div className="flex flex-col gap-2 sm:col-span-2">
    <span className="text-sm font-medium text-secondary-text" data-required>Pieces, in order</span>
    <ul className="flex flex-col gap-1">
      {parts.map((p, i) => (
        <li key={i} className="flex items-center gap-2">
          {p.current ? (
            <span className="flex-1 rounded-lg border border-dashed border-border-color px-2 py-2 text-sm text-secondary-text">The value so far</span>
          ) : "column" in p ? (
            <ComboField ariaLabel={`Piece ${i + 1} column`} className="flex-1" value={p.column} onChange={(v) => onChange(parts.map((x, j) => (j === i ? { column: v ?? "" } : x)))} options={columns.map((c) => ({ value: c, label: c }))} disabled={readOnly} required />
          ) : (
            <Field aria-label={`Piece ${i + 1} text`} label="" className="flex-1" value={p.text} onChange={(e) => onChange(parts.map((x, j) => (j === i ? { text: e.target.value } : x)))} disabled={readOnly} />
          )}
          {!readOnly && (
            <button type="button" aria-label={`Remove piece ${i + 1}`} onClick={() => onChange(parts.filter((_, j) => j !== i))} className="rounded-lg p-1.5 text-secondary-text hover:bg-border-color">
              <Trash2Icon />
            </button>
          )}
        </li>
      ))}
    </ul>
    {!readOnly && (
      <div className="flex flex-wrap gap-2 text-sm">
        <button type="button" className="text-link-color hover:underline" onClick={() => onChange([...parts, { column: columns[0] ?? "" }])}>Add a column</button>
        <button type="button" className="text-link-color hover:underline" onClick={() => onChange([...parts, { text: "" }])}>Add text</button>
        {!parts.some((p) => p.current) && <button type="button" className="text-link-color hover:underline" onClick={() => onChange([...parts, { current: true }])}>Add the value so far</button>}
      </div>
    )}
  </div>
);

/** One setting of a step, by its type. */
const Setting = ({ def, step, set, columns, readOnly }) => {
  const v = step[def.key];
  switch (def.type) {
    case "select":
      return <ComboField label={def.label} value={v ?? def.default ?? null} onChange={(x) => set({ [def.key]: x ?? def.default })} options={def.options} required={def.required || def.default !== undefined} disabled={readOnly} />;
    case "boolean":
      return (
        <div className="flex items-end pb-1.5">
          <Switch checked={v ?? def.default ?? false} onChange={(e) => set({ [def.key]: e.target.checked })} disabled={readOnly}>{def.label}</Switch>
        </div>
      );
    case "number":
      return <Field label={def.label} type="number" min={def.min} max={def.max} value={v ?? ""} onChange={(e) => set({ [def.key]: e.target.value === "" ? "" : Number(e.target.value) })} required={def.required} disabled={readOnly} />;
    case "date": {
      const pattern = v !== undefined && !KNOWN_DATE.includes(v);
      return (
        <>
          <ComboField label={def.label} value={pattern ? "pattern" : v ?? "iso"} onChange={(x) => set({ format: x === "pattern" ? "dd.MM.yyyy" : x ?? "iso" })} options={STEP_DATE_FORMATS} required disabled={readOnly} />
          {pattern && <Field label="Pattern" value={v} onChange={(e) => set({ format: e.target.value })} hint="yyyy or yy, MM or M, dd or d; other characters as written" required disabled={readOnly} />}
        </>
      );
    }
    case "values":
      return (
        <TextAreaField
          className="sm:col-span-2"
          label={def.label}
          value={step._valuesText ?? formatValueMap(v)}
          onChange={(e) => set({ _valuesText: e.target.value, values: parseValueMap(e.target.value) })}
          rows={3}
          required
          disabled={readOnly}
        />
      );
    case "list":
      return (
        <TextAreaField
          className="sm:col-span-2"
          label={def.label}
          value={step._listText ?? (v ?? []).join("\n")}
          onChange={(e) => set({ _listText: e.target.value, list: e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) })}
          rows={3}
          disabled={readOnly}
        />
      );
    case "columns":
      return (
        <div className="flex flex-col gap-2 sm:col-span-2">
          <ComboField label="Add a column" value={null} onChange={(x) => x && set({ columns: [...(v ?? []), x] })} options={columns.filter((c) => !(v ?? []).includes(c)).map((c) => ({ value: c, label: c }))} disabled={readOnly} required={!(v ?? []).length} />
          <div className="flex flex-wrap gap-1">
            {(v ?? []).map((c) => (
              <span key={c} className="inline-flex items-center gap-1 rounded-full bg-border-color px-2 py-0.5 text-xs text-primary-text">
                {c}
                {!readOnly && <button type="button" aria-label={`Remove ${c}`} onClick={() => set({ columns: v.filter((x) => x !== c) })}>×</button>}
              </span>
            ))}
          </div>
        </div>
      );
    case "parts":
      return <PartsEditor parts={v ?? []} onChange={(parts) => set({ parts })} columns={columns} readOnly={readOnly} />;
    default:
      return <Field label={def.label} value={v ?? ""} onChange={(e) => set({ [def.key]: e.target.value })} required={def.required} disabled={readOnly} />;
  }
};

/**
 * The steps of a field row, in order: add, move, remove, and each step's settings. Beside each step, the value after it for the example row (from the
 * server preview, so it is what the import will do). Everyone who can import may change the steps; saving them into a template needs managing rights.
 */
const StepEditor = ({ steps, onChange, columns, after = [], error, readOnly = false, label = "Steps" }) => {
  const set = (i, patch) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i, d) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-secondary-text">{label}</span>
        {!readOnly && (
          <div className="w-56">
            <ComboField ariaLabel="Add a step" placeholder="Add a step…" value={null} onChange={(k) => k && onChange([...steps, newStep(k)])} options={STEP_OPTIONS} />
          </div>
        )}
      </div>
      {steps.length === 0 && <p className="text-xs text-tertiary-text">No steps: the value is used as it is taken.</p>}
      <ol className="flex flex-col gap-2">
        {steps.map((s, i) => {
          const def = STEP_BY_KIND[s.kind];
          const problem = stepProblem(s);
          const failedHere = error && i === after.length;
          return (
            <li key={i} aria-label={`Step ${i + 1}: ${def?.label ?? s.kind}`} className={`rounded-lg border p-2 ${problem || failedHere ? "border-error-color/60" : "border-border-color"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-border-color text-xs font-semibold text-secondary-text">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary-text" title={describeStep(s)}>{describeStep(s)}</span>
                <span
                  aria-label={`After step ${i + 1}`}
                  className={`max-w-[14rem] truncate rounded px-2 py-0.5 text-xs ${failedHere ? "bg-error-color/10 text-error-color" : "bg-secondary-bg text-primary-text"}`}
                  title={failedHere ? error : after[i]}>
                  {failedHere ? error : i < after.length ? after[i] || "(empty)" : "—"}
                </span>
                {!readOnly && (
                  <span className="flex items-center">
                    <button type="button" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 text-secondary-text hover:bg-border-color disabled:opacity-30"><ArrowUpIcon /></button>
                    <button type="button" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)} className="rounded p-1 text-secondary-text hover:bg-border-color disabled:opacity-30"><ArrowDownIcon /></button>
                    <button type="button" aria-label={`Remove step ${i + 1}`} onClick={() => onChange(steps.filter((_, j) => j !== i))} className="rounded p-1 text-secondary-text hover:bg-border-color"><Trash2Icon /></button>
                  </span>
                )}
              </div>
              {def?.settings.length > 0 && (
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {def.settings.filter((d) => !d.showWhen || d.showWhen(s)).map((d) => (
                    <Setting key={d.key} def={d} step={s} set={(patch) => set(i, patch)} columns={columns} readOnly={readOnly} />
                  ))}
                </div>
              )}
              {problem && <p className="mt-1 text-xs text-error-color">{problem}</p>}
            </li>
          );
        })}
      </ol>
      {!readOnly && steps.length > 0 && (
        <button type="button" className="flex items-center gap-1 self-start text-xs text-link-color hover:underline" onClick={() => onChange([...steps, newStep("trim")])}>
          <PlusIcon /> Add another step
        </button>
      )}
    </section>
  );
};

export default StepEditor;
