import { useState } from "react";
import { XIcon } from "@/components/icons";
import { useNCMFilters } from "../hooks/useNCMFilters";
import { useClassifications } from "../hooks/useNcr";
import { STAGES } from "../lib/ncr";

const selectClass = "w-full h-8 bg-text-input-color border border-border-color rounded-md px-2 mt-1 text-primary-text";

/** Register filters: stages, failure mode, sub-failure mode and deleted records. */
const FilterPane = ({ onClose }) => {
  const filters = useNCMFilters();
  const { data: lists } = useClassifications();
  const [stages, setStages] = useState(filters.stage ? filters.stage.split(",") : []);
  const [failureMode, setFailureMode] = useState(filters.failureMode);
  const [subFailureMode, setSubFailureMode] = useState(filters.subFailureMode);
  const [deleted, setDeleted] = useState(filters.deleted || "exclude");
  const subs = (lists?.subFailureModes ?? []).filter((s) => !failureMode || s.parentId === failureMode);

  const toggleStage = (key) => setStages((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
  const apply = (values) => {
    filters.updateFilters(values);
    onClose?.();
  };

  return (
    <div
      role="dialog"
      aria-label="Filter non-conformances"
      className="border absolute bg-primary-bg text-primary-text z-1000 top-32 right-4 rounded-2xl border-border-color shadow-lg shadow-shadow-color w-80 h-fit">
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
            {STAGES.map((s) => (
              <label key={s.key} className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs ${stages.includes(s.key) ? "border-theme bg-theme/10" : "border-border-color"}`}>
                <input type="checkbox" className="sr-only" checked={stages.includes(s.key)} onChange={() => toggleStage(s.key)} />
                {s.label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="text-sm font-medium">
          Failure mode
          <select
            className={selectClass}
            value={failureMode}
            onChange={(e) => {
              setFailureMode(e.target.value);
              setSubFailureMode("");
            }}>
            <option value="">All</option>
            {(lists?.failureModes ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.code ? `${o.code} – ` : ""}
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium">
          Sub-failure mode
          <select className={selectClass} value={subFailureMode} onChange={(e) => setSubFailureMode(e.target.value)}>
            <option value="">All</option>
            {subs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium">
          Deleted records
          <select className={selectClass} value={deleted} onChange={(e) => setDeleted(e.target.value)}>
            <option value="exclude">Hide deleted</option>
            <option value="include">Include deleted</option>
            <option value="only">Only deleted</option>
          </select>
        </label>
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
          onClick={() => apply({ stage: stages.join(","), failureMode, subFailureMode, deleted: deleted === "exclude" ? "" : deleted })}>
          Apply
        </button>
      </div>
    </div>
  );
};

export default FilterPane;
