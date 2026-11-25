import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "@/components/icons";
import { CONTROL_PLAN_FILTER_KEYS, useControlPlanFilters } from "../../hooks/useUrlFilters";
import { REVISION_STATE_OPTIONS } from "../../lib/controlPlans";
import SlidingToggle from "../ui/SlidingToggle";
import DateRangeFilter from "../ui/DateRangeFilter";
import CTAButton from "@/components/CTAButton";

const ACTIVE_OPTIONS = [
  { value: "", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "all", label: "All" },
];

/** Pill multi-select. */
const Pills = ({ legend, options, selected, onToggle, none }) => (
  <fieldset>
    <legend className="text-sm font-medium">{legend}</legend>
    <div className="mt-1 flex flex-wrap gap-1">
      {options.map((o) => {
        const on = selected.includes(o.key);
        return (
          <label key={o.key} className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs ${on ? "border-brand-primary bg-brand-primary text-white" : "border-border-color hover:bg-border-color/40"}`}>
            <input type="checkbox" className="sr-only" checked={on} onChange={() => onToggle(o.key)} />
            {o.label}
          </label>
        );
      })}
    </div>
    <p className="mt-1 text-xs text-secondary-text">{selected.length ? `${selected.length} selected` : none}</p>
  </fieldset>
);

/**
 * Control plan register filters (kept in the URL) in the same full-height right-hand drawer as the other registers: the state of the plan's
 * revisions (any of those chosen), part families, active or inactive, "only mine" and when it last changed. Choices apply with "Apply".
 * `families` is the list the person can choose from: `[{ id, code, name }]`.
 */
const PlanFilterPane = ({ families = [], onClose }) => {
  const filters = useControlPlanFilters();
  const list = (v) => (v ? v.split(",") : []);
  const [states, setStates] = useState(list(filters.status));
  const [chosenFamilies, setChosenFamilies] = useState(list(filters.family));
  const [active, setActive] = useState(filters.active || "");
  const [mine, setMine] = useState(filters.owner === "me");
  const [from, setFrom] = useState(filters.from || null);
  const [to, setTo] = useState(filters.to || null);
  const paneRef = useRef(null);
  const [closing, setClosing] = useState(false);
  const close = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => onClose?.(), 180);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    // An Escape already used to close a dropdown inside the pane leaves the pane open.
    const onKey = (e) => e.key === "Escape" && !e.defaultPrevented && closeRef.current();
    document.addEventListener("keydown", onKey);
    paneRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const toggle = (setter) => (key) => setter((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
  const apply = (values) => {
    filters.updateFilters(values);
    close();
  };
  const applyAll = () => apply({ status: states.join(","), family: chosenFamilies.join(","), active, owner: mine ? "me" : "", from: from ?? "", to: to ?? "" });
  const resetAll = () => apply(Object.fromEntries(CONTROL_PLAN_FILTER_KEYS.filter((k) => k !== "search").map((k) => [k, ""])));

  return createPortal(
    <div className="fixed inset-0 z-[9000]">
      <div aria-hidden="true" onMouseDown={close} className={`absolute inset-0 bg-black/30 ${closing ? "animate-out fade-out" : "animate-in fade-in"} duration-200 fill-mode-forwards`} />
      <aside
        ref={paneRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Filter control plans"
        className={`absolute inset-y-0 right-0 flex h-dvh w-96 max-w-full flex-col border-l border-border-color bg-primary-bg text-primary-text shadow-2xl shadow-shadow-color outline-none ${
          closing ? "animate-out slide-out-to-right" : "animate-in slide-in-from-right"
        } duration-200 ease-out fill-mode-forwards`}>
        <div className="flex shrink-0 flex-row items-center justify-between border-b border-border-color bg-secondary-bg px-4 py-3">
          <h3 className="text-xl">Filter</h3>
          <button type="button" aria-label="Close filters" className="rounded-md p-1 hover:bg-primary-bg hover:text-error-color cursor-pointer" onClick={close}>
            <XIcon />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <Pills legend="Revisions" options={REVISION_STATE_OPTIONS} selected={states} onToggle={toggle(setStates)} none="Any state" />
          {families.length > 0 && (
            <Pills legend="Part family" options={families.map((f) => ({ key: f.id, label: f.code }))} selected={chosenFamilies} onToggle={toggle(setChosenFamilies)} none="Any family" />
          )}
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Plans</span>
            <SlidingToggle ariaLabel="Active or inactive plans" options={ACTIVE_OPTIONS} value={active} onChange={setActive} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only plans I own
          </label>
          <DateRangeFilter label="Changed" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to); }} />
        </div>
        <div className="flex shrink-0 justify-between gap-2 border-t border-border-color bg-secondary-bg px-4 py-3">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={resetAll}>
            Reset all
          </CTAButton>
          <CTAButton buttonType="button" type="main" size="md" onClick={applyAll}>
            Apply
          </CTAButton>
        </div>
      </aside>
    </div>,
    document.body
  );
};

export default PlanFilterPane;
