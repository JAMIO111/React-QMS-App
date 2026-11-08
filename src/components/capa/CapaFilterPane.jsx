import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "@/components/icons";
import { CAPA_FILTER_KEYS, useCapaFilters } from "../../hooks/useUrlFilters";
import { SEVERITIES, SOURCES, STAGES } from "../../lib/capa";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import CTAButton from "@/components/CTAButton";

const STAGE_OPTIONS = STAGES.map((s) => ({ key: s.key, label: s.label }));
const SOURCE_OPTIONS = SOURCES.map((s) => ({ key: s.id, label: s.name }));
const SEVERITY_OPTIONS = SEVERITIES.map((s) => ({ key: s.id, label: s.name }));

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

const Check = ({ label, checked, onChange }) => (
  <label className="flex items-center gap-2 text-sm">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
  </label>
);

/**
 * 8D register filters (kept in the URL) in the same full-height right-hand drawer as the other registers: stage, source, severity,
 * "only mine", "overdue" and the started dates. With no stage chosen the register shows running 8Ds. Choices apply with "Apply".
 */
const CapaFilterPane = ({ onClose }) => {
  const filters = useCapaFilters();
  const list = (v) => (v ? v.split(",") : []);
  const [stages, setStages] = useState(list(filters.stage));
  const [sources, setSources] = useState(list(filters.source));
  const [severities, setSeverities] = useState(list(filters.severity));
  const [mine, setMine] = useState(filters.owner === "me");
  const [overdue, setOverdue] = useState(filters.overdue === "true");
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
  const applyAll = () =>
    apply({ stage: stages.join(","), source: sources.join(","), severity: severities.join(","), owner: mine ? "me" : "", overdue: overdue ? "true" : "", from: from ?? "", to: to ?? "" });
  const resetAll = () => apply(Object.fromEntries(CAPA_FILTER_KEYS.filter((k) => k !== "search").map((k) => [k, ""])));

  return createPortal(
    <div className="fixed inset-0 z-[9000]">
      <div aria-hidden="true" onMouseDown={close} className={`absolute inset-0 bg-black/30 ${closing ? "animate-out fade-out" : "animate-in fade-in"} duration-200 fill-mode-forwards`} />
      <aside
        ref={paneRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Filter 8Ds"
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
          <Pills legend="Stage" options={STAGE_OPTIONS} selected={stages} onToggle={toggle(setStages)} none="None chosen: running 8Ds (not closed or cancelled)" />
          <Pills legend="Source" options={SOURCE_OPTIONS} selected={sources} onToggle={toggle(setSources)} none="Any source" />
          <Pills legend="Severity" options={SEVERITY_OPTIONS} selected={severities} onToggle={toggle(setSeverities)} none="Any severity" />
          <div className="flex flex-col gap-2">
            <Check label="Only 8Ds I own" checked={mine} onChange={setMine} />
            <Check label="Overdue only" checked={overdue} onChange={setOverdue} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <RHFDatePickerPopout label="Started from" placeholder="Any date" valueFormat="iso" clearable value={from} onChange={setFrom} maxDate={to ?? undefined} />
            <RHFDatePickerPopout label="Started to" placeholder="Any date" valueFormat="iso" clearable value={to} onChange={setTo} minDate={from ?? undefined} />
          </div>
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

export default CapaFilterPane;
