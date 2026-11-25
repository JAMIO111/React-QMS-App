import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { MSA_FILTER_KEYS, useMsaFilters } from "../../hooks/useUrlFilters";
import { STATUS_FILTERS, TYPE_FILTERS, VALIDITY_FILTERS, VERDICT_FILTERS } from "../../lib/msa";

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
 * Measurement system study filters (kept in the URL) in the right-hand drawer the other registers use: state, kind, result and whether the study is still
 * valid. With no state chosen the register shows every study but cancelled ones. Choices apply with "Apply".
 */
const MsaFilterPane = ({ onClose }) => {
  const filters = useMsaFilters();
  const list = (v) => (v ? v.split(",") : []);
  const [status, setStatus] = useState(list(filters.status));
  const [type, setType] = useState(list(filters.type));
  const [verdict, setVerdict] = useState(list(filters.verdict));
  const [valid, setValid] = useState(list(filters.valid));
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

  return createPortal(
    <div className="fixed inset-0 z-[9000]">
      <div aria-hidden="true" onMouseDown={close} className={`absolute inset-0 bg-black/30 ${closing ? "animate-out fade-out" : "animate-in fade-in"} duration-200 fill-mode-forwards`} />
      <aside
        ref={paneRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Filter studies"
        className={`absolute inset-y-0 right-0 flex h-dvh w-96 max-w-full flex-col border-l border-border-color bg-primary-bg text-primary-text shadow-2xl shadow-shadow-color outline-none ${closing ? "animate-out slide-out-to-right" : "animate-in slide-in-from-right"} duration-200 ease-out fill-mode-forwards`}>
        <div className="flex shrink-0 flex-row items-center justify-between border-b border-border-color bg-secondary-bg px-4 py-3">
          <h3 className="text-xl">Filter</h3>
          <button type="button" aria-label="Close filters" className="cursor-pointer rounded-md p-1 hover:bg-primary-bg hover:text-error-color" onClick={close}>
            <XIcon />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <Pills legend="State" options={STATUS_FILTERS} selected={status} onToggle={toggle(setStatus)} none="None chosen: every study but cancelled ones" />
          <Pills legend="Kind" options={TYPE_FILTERS} selected={type} onToggle={toggle(setType)} none="Any kind" />
          <Pills legend="Result" options={VERDICT_FILTERS} selected={verdict} onToggle={toggle(setVerdict)} none="Any result" />
          <Pills legend="Validity" options={VALIDITY_FILTERS} selected={valid} onToggle={toggle(setValid)} none="Any (completed studies only are valid or expired)" />
        </div>
        <div className="flex shrink-0 justify-between gap-2 border-t border-border-color bg-secondary-bg px-4 py-3">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={() => apply(Object.fromEntries(MSA_FILTER_KEYS.filter((k) => k !== "search").map((k) => [k, ""])))}>
            Reset all
          </CTAButton>
          <CTAButton buttonType="button" type="main" size="md" onClick={() => apply({ status: status.join(","), type: type.join(","), verdict: verdict.join(","), valid: valid.join(",") })}>
            Apply
          </CTAButton>
        </div>
      </aside>
    </div>,
    document.body
  );
};

export default MsaFilterPane;
