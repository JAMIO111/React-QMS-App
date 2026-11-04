import { useEffect, useRef, useState } from "react";
import { XIcon, TagIcon, TagsIcon, Trash2Icon } from "@/components/icons";
import { useNCMFilters } from "../hooks/useNCMFilters";
import { useClassifications } from "../hooks/useNcr";
import { STAGES } from "../lib/ncr";
import RHFComboBox from "./ui/RHFComboBox";

const DELETED_OPTIONS = [
  { id: "exclude", name: "Hide deleted" },
  { id: "include", name: "Include deleted" },
  { id: "only", name: "Only deleted" },
];

/**
 * Register filters (kept in the URL): stages, failure mode, sub-failure mode and deleted records.
 * Choices apply with "Apply"; Escape or a click outside closes without applying.
 */
const FilterPane = ({ onClose }) => {
  const filters = useNCMFilters();
  const { data: lists } = useClassifications();
  const [stages, setStages] = useState(filters.stage ? filters.stage.split(",") : []);
  const [failureMode, setFailureMode] = useState(filters.failureMode || null);
  const [subFailureMode, setSubFailureMode] = useState(filters.subFailureMode || null);
  const [deleted, setDeleted] = useState(filters.deleted || "exclude");
  const paneRef = useRef(null);

  const failureModes = (lists?.failureModes ?? []).map((f) => ({ id: f.id, name: f.code ? `${f.code} – ${f.name}` : f.name }));
  const parentName = Object.fromEntries((lists?.failureModes ?? []).map((f) => [f.id, f.name]));
  // Without a failure mode, every sub-failure mode is offered with its failure mode beside it.
  const subs = (lists?.subFailureModes ?? [])
    .filter((s) => !failureMode || s.parentId === failureMode)
    .map((s) => ({ id: s.id, name: s.name, hint: failureMode ? undefined : parentName[s.parentId] }));

  useEffect(() => {
    // An Escape already used to close a dropdown inside the pane leaves the pane open.
    const onKey = (e) => e.key === "Escape" && !e.defaultPrevented && onClose?.();
    const onDown = (e) => {
      if (paneRef.current && !paneRef.current.contains(e.target) && !e.target.closest?.('[aria-label="Filter"], [title="Filter"]')) onClose?.();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const toggleStage = (key) => setStages((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
  const apply = (values) => {
    filters.updateFilters(values);
    onClose?.();
  };

  return (
    <div
      ref={paneRef}
      role="dialog"
      aria-label="Filter non-conformances"
      className="border absolute bg-primary-bg text-primary-text z-1000 top-32 right-4 rounded-2xl border-border-color shadow-lg shadow-shadow-color w-88 max-w-[calc(100vw-2rem)] h-fit">
      <div className="flex px-4 py-1 bg-secondary-bg border-b border-border-color flex-row justify-between items-center rounded-t-2xl">
        <h3 className="text-xl">Filter</h3>
        <button type="button" aria-label="Close filters" className="hover:bg-primary-bg rounded-md cursor-pointer hover:text-error-color p-1" onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <div className="flex flex-col gap-4 px-4 py-3">
        <fieldset>
          <legend className="text-sm font-medium">Stage</legend>
          <div className="mt-1 flex flex-wrap gap-1">
            {STAGES.map((s) => {
              const on = stages.includes(s.key);
              return (
                <label key={s.key} className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs ${on ? "border-brand-primary bg-brand-primary text-white" : "border-border-color hover:bg-border-color/40"}`}>
                  <input type="checkbox" className="sr-only" checked={on} onChange={() => toggleStage(s.key)} />
                  {s.label}
                </label>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-secondary-text">{stages.length ? `${stages.length} selected` : "All stages"}</p>
        </fieldset>
        <RHFComboBox
          label="Failure mode"
          icon={TagIcon}
          placeholder="All failure modes"
          options={failureModes}
          value={failureMode}
          onChange={(v) => {
            setFailureMode(v);
            setSubFailureMode(null);
          }}
        />
        <RHFComboBox label="Sub-failure mode" icon={TagsIcon} placeholder="All sub-failure modes" options={subs} value={subFailureMode} onChange={setSubFailureMode} />
        <RHFComboBox label="Deleted records" icon={Trash2Icon} options={DELETED_OPTIONS} value={deleted} onChange={(v) => setDeleted(v ?? "exclude")} sort={false} clearable={false} />
      </div>
      <div className="flex justify-between gap-2 border-t border-border-color px-4 py-3">
        <button
          type="button"
          className="rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm hover:bg-neutral-btn-bg-hover cursor-pointer"
          onClick={() => apply({ stage: "", failureMode: "", subFailureMode: "", deleted: "" })}>
          Reset all
        </button>
        <button
          type="button"
          className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-3 py-1.5 text-sm hover:bg-cta-btn-bg-hover cursor-pointer"
          onClick={() =>
            apply({ stage: stages.join(","), failureMode: failureMode ?? "", subFailureMode: subFailureMode ?? "", deleted: deleted === "exclude" ? "" : deleted })
          }>
          Apply
        </button>
      </div>
    </div>
  );
};

export default FilterPane;
