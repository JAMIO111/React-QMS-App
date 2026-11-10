import CustomFieldFilters from "../custom-fields/CustomFieldFilters";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "@/components/icons";
import { SUPPLIER_FILTER_KEYS, useSupplierFilters } from "../../hooks/useUrlFilters";
import { useSupplierClassifications } from "../../hooks/useSupplierQuality";
import { RISK_RATINGS, SUPPLIER_STATUSES, SUPPLIER_TYPES } from "../../lib/supplierQuality";
import SlidingToggle from "../ui/SlidingToggle";
import CTAButton from "@/components/CTAButton";

const STATUS_OPTIONS = SUPPLIER_STATUSES.map((s) => ({ key: s.key, label: s.label }));
const TYPE_OPTIONS = SUPPLIER_TYPES.map((t) => ({ key: t.id, label: t.name }));
const RISK_OPTIONS = RISK_RATINGS.map((r) => ({ key: r.id, label: r.name }));
const ACTIVITY_OPTIONS = [
  { value: "active", label: "Active" },
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
 * Supplier register filters (kept in the URL) in the same right-hand drawer as the other registers: approval status, type, classification, risk and activity
 * (approval and activity are separate). Choices apply with "Apply".
 */
const SupplierFilterPane = ({ onClose }) => {
  const filters = useSupplierFilters();
  const classifications = useSupplierClassifications({ all: true });
  const list = (v) => (v ? v.split(",") : []);
  const [statuses, setStatuses] = useState(list(filters.status));
  const [types, setTypes] = useState(list(filters.type));
  const [classes, setClasses] = useState(list(filters.classification));
  const [risks, setRisks] = useState(list(filters.risk));
  const [activity, setActivity] = useState(filters.active || "active");
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
  const classOptions = (classifications.data?.data ?? []).map((c) => ({ key: c.id, label: c.active ? c.label : `${c.label} (off)` }));
  const applyAll = () =>
    apply({ status: statuses.join(","), type: types.join(","), classification: classes.join(","), risk: risks.join(","), active: activity === "active" ? "" : activity });
  const resetAll = () => apply(Object.fromEntries(SUPPLIER_FILTER_KEYS.filter((k) => k !== "search").map((k) => [k, ""])));

  return createPortal(
    <div className="fixed inset-0 z-[9000]">
      <div aria-hidden="true" onMouseDown={close} className={`absolute inset-0 bg-black/30 ${closing ? "animate-out fade-out" : "animate-in fade-in"} duration-200 fill-mode-forwards`} />
      <aside
        ref={paneRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Filter suppliers"
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
          <Pills legend="Approval status" options={STATUS_OPTIONS} selected={statuses} onToggle={toggle(setStatuses)} none="Any approval status" />
          <Pills legend="Supplier type" options={TYPE_OPTIONS} selected={types} onToggle={toggle(setTypes)} none="Any type" />
          <Pills legend="Classification" options={classOptions} selected={classes} onToggle={toggle(setClasses)} none="Any classification" />
          <Pills legend="Risk" options={RISK_OPTIONS} selected={risks} onToggle={toggle(setRisks)} none="Any risk" />
          <div>
            <p className="mb-1 text-sm font-medium">Activity</p>
            <SlidingToggle ariaLabel="Activity" mode="radio" options={ACTIVITY_OPTIONS} value={activity} onChange={setActivity} />
            <p className="mt-1 text-xs text-secondary-text">Whether the supplier is in use, separate from its approval.</p>
          </div>
          <CustomFieldFilters entityType="supplier" />
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

export default SupplierFilterPane;
