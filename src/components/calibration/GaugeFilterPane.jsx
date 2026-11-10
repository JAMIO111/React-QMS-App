import CustomFieldFilters from "../custom-fields/CustomFieldFilters";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FactoryIcon, HouseIcon, TagIcon, Trash2Icon, UsersIcon, XIcon } from "@/components/icons";
import { useGaugeTypes } from "../../hooks/useCalibration";
import { useSites } from "../../hooks/useQmsApi";
import { useGaugeFilters } from "../../hooks/useUrlFilters";
import { DUE_FILTERS, GAUGE_STATUSES, OUTCOMES } from "../../lib/calibration";
import RHFComboBox from "../ui/RHFComboBox";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { PartyPicker } from "../ncr/Pickers";
import CTAButton from "@/components/CTAButton";

const DELETED_OPTIONS = [
  { id: "exclude", name: "Hide deleted" },
  { id: "include", name: "Include deleted" },
  { id: "only", name: "Only deleted" },
];
const SOURCES = [
  { id: "internal", name: "In-house" },
  { id: "external", name: "External (calibration supplier)" },
];

/** Pill multi-select. */
const Pills = ({ legend, options, selected, onToggle }) => (
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
    <p className="mt-1 text-xs text-secondary-text">{selected.length ? `${selected.length} selected` : `Any ${legend.toLowerCase()}`}</p>
  </fieldset>
);

/**
 * Gauge register filters (kept in the URL), in the same full-height right-hand drawer as the NC
 * registers: due, status, last result, next-due dates, type, site, how it is calibrated, supplier
 * and deleted gauges. Choices apply with "Apply"; Escape, the backdrop or the close button leave.
 */
const GaugeFilterPane = ({ onClose }) => {
  const filters = useGaugeFilters();
  const { data: types } = useGaugeTypes({ includeInactive: true });
  const { data: sites } = useSites({ includeInactive: true });
  const list = (v) => (v ? v.split(",") : []);
  const [due, setDue] = useState(list(filters.due));
  const [statuses, setStatuses] = useState(list(filters.status));
  const [outcomes, setOutcomes] = useState(list(filters.outcome));
  const [from, setFrom] = useState(filters.from || null);
  const [to, setTo] = useState(filters.to || null);
  const [type, setType] = useState(filters.type || null);
  const [site, setSite] = useState(filters.site || null);
  const [source, setSource] = useState(filters.source || null);
  const [supplier, setSupplier] = useState(filters.supplier ? { id: filters.supplier, name: filters.supplierLabel } : null);
  const [deleted, setDeleted] = useState(filters.deleted || "exclude");
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
    apply({
      due: due.join(","),
      status: statuses.join(","),
      outcome: outcomes.join(","),
      from: from ?? "",
      to: to ?? "",
      type: type ?? "",
      site: site ?? "",
      source: source ?? "",
      supplier: supplier?.id ?? "",
      supplierLabel: supplier?.id ? supplier.name ?? "" : "",
      deleted: deleted === "exclude" ? "" : deleted,
    });
  const resetAll = () => apply(Object.fromEntries(["due", "status", "outcome", "from", "to", "type", "site", "source", "supplier", "supplierLabel", "deleted"].map((k) => [k, ""])));

  return createPortal(
    <div className="fixed inset-0 z-[9000]">
      <div aria-hidden="true" onMouseDown={close} className={`absolute inset-0 bg-black/30 ${closing ? "animate-out fade-out" : "animate-in fade-in"} duration-200 fill-mode-forwards`} />
      <aside
        ref={paneRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Filter gauges"
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
          <Pills legend="Due" options={DUE_FILTERS} selected={due} onToggle={toggle(setDue)} />
          <Pills legend="Status" options={GAUGE_STATUSES} selected={statuses} onToggle={toggle(setStatuses)} />
          <Pills legend="Last result" options={OUTCOMES} selected={outcomes} onToggle={toggle(setOutcomes)} />
          <div className="grid grid-cols-2 gap-2">
            <RHFDatePickerPopout label="Next due from" placeholder="Any date" valueFormat="iso" clearable value={from} onChange={setFrom} maxDate={to ?? undefined} />
            <RHFDatePickerPopout label="Next due to" placeholder="Any date" valueFormat="iso" clearable value={to} onChange={setTo} minDate={from ?? undefined} />
          </div>
          <RHFComboBox label="Gauge type" icon={TagIcon} placeholder="All types" options={(types ?? []).map((t) => ({ id: t.id, name: t.name, hint: t.active ? t.code : `${t.code} · Inactive` }))} value={type} onChange={setType} />
          <RHFComboBox label="Site" icon={HouseIcon} placeholder="All sites" options={(sites?.data ?? []).map((s) => ({ id: s.id, name: `${s.code} · ${s.name}` }))} value={site} onChange={setSite} />
          <RHFComboBox label="Calibrated" icon={FactoryIcon} placeholder="In-house or external" options={SOURCES} value={source} onChange={setSource} sort={false} />
          <PartyPicker kind="suppliers" label="Calibration supplier" icon={UsersIcon} value={supplier?.id ?? null} current={supplier?.id ? { id: supplier.id, name: supplier.name ?? "" } : undefined}
            onChange={(id, item) => setSupplier(id ? { id, name: item?.name ?? supplier?.name } : null)} />
          <RHFComboBox label="Deleted gauges" icon={Trash2Icon} options={DELETED_OPTIONS} value={deleted} onChange={(v) => setDeleted(v ?? "exclude")} sort={false} clearable={false} />
          <CustomFieldFilters entityType="gauge" />
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

export default GaugeFilterPane;
