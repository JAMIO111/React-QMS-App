import CustomFieldFilters from "../custom-fields/CustomFieldFilters";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FactoryIcon, HouseIcon, QrCodeIcon, XIcon } from "@/components/icons";
import { useMachines } from "../../hooks/useProcessControl";
import { useSites } from "../../hooks/useQmsApi";
import { INSPECTION_FILTER_KEYS, useInspectionFilters } from "../../hooks/useUrlFilters";
import { STATUS, TRIGGER_LABEL } from "../../lib/inspection";
import RHFComboBox from "../ui/RHFComboBox";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { PartPicker } from "../ncr/Pickers";
import { OrderPicker } from "../production/pickers";
import CTAButton from "@/components/CTAButton";

const STATUS_OPTIONS = Object.entries(STATUS).map(([key, v]) => ({ key, label: v.label }));
const RESULT_OPTIONS = [
  { key: "pass", label: "Pass" },
  { key: "fail", label: "Fail" },
];
const TRIGGER_OPTIONS = Object.entries(TRIGGER_LABEL).map(([key, label]) => ({ key, label }));

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
 * In-process inspection filters (kept in the URL), in the same full-height right-hand drawer as the NC and gauge
 * registers: status, result, sampling trigger, started dates, part, site and machine. Choices apply with "Apply";
 * Escape, the backdrop or the close button leave.
 */
const InspectionFilterPane = ({ onClose }) => {
  const filters = useInspectionFilters();
  const { data: sites } = useSites({ includeInactive: true });
  const machines = useMachines({ includeInactive: true });
  const list = (v) => (v ? v.split(",") : []);
  const [statuses, setStatuses] = useState(list(filters.status));
  const [results, setResults] = useState(list(filters.result));
  const [triggers, setTriggers] = useState(list(filters.trigger));
  const [from, setFrom] = useState(filters.from || null);
  const [to, setTo] = useState(filters.to || null);
  const [part, setPart] = useState(filters.part ? { id: filters.part, name: filters.partLabel } : null);
  const [order, setOrder] = useState(filters.order ? { id: filters.order, name: filters.orderLabel } : null);
  const [site, setSite] = useState(filters.site || null);
  const [machine, setMachine] = useState(filters.machine || null);
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

  const machineItems = machines.data?.items ?? [];
  const toggle = (setter) => (key) => setter((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
  const apply = (values) => {
    filters.updateFilters(values);
    close();
  };
  const applyAll = () => {
    const picked = machineItems.find((m) => m.id === machine);
    apply({
      status: statuses.join(","),
      result: results.join(","),
      trigger: triggers.join(","),
      from: from ?? "",
      to: to ?? "",
      part: part?.id ?? "",
      partLabel: part?.id ? part.name ?? "" : "",
      order: order?.id ?? "",
      orderLabel: order?.id ? order.name ?? "" : "",
      site: site ?? "",
      machine: machine ?? "",
      machineLabel: machine ? (picked ? `${picked.code} · ${picked.name}` : filters.machineLabel) : "",
    });
  };
  const resetAll = () => apply(Object.fromEntries(INSPECTION_FILTER_KEYS.filter((k) => k !== "search").map((k) => [k, ""])));

  return createPortal(
    <div className="fixed inset-0 z-[9000]">
      <div aria-hidden="true" onMouseDown={close} className={`absolute inset-0 bg-black/30 ${closing ? "animate-out fade-out" : "animate-in fade-in"} duration-200 fill-mode-forwards`} />
      <aside
        ref={paneRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Filter inspections"
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
          <Pills legend="Status" options={STATUS_OPTIONS} selected={statuses} onToggle={toggle(setStatuses)} />
          <Pills legend="Result" options={RESULT_OPTIONS} selected={results} onToggle={toggle(setResults)} />
          <Pills legend="Trigger" options={TRIGGER_OPTIONS} selected={triggers} onToggle={toggle(setTriggers)} />
          <div className="grid grid-cols-2 gap-2">
            <RHFDatePickerPopout label="Started from" placeholder="Any date" valueFormat="iso" clearable value={from} onChange={setFrom} maxDate={to ?? undefined} />
            <RHFDatePickerPopout label="Started to" placeholder="Any date" valueFormat="iso" clearable value={to} onChange={setTo} minDate={from ?? undefined} />
          </div>
          <PartPicker label="Part number" icon={QrCodeIcon} value={part?.id ?? null} current={part?.id ? { id: part.id, partNumber: part.name ?? "" } : undefined}
            onChange={(id, item) => setPart(id ? { id, name: item?.name ?? part?.name } : null)} />
          <OrderPicker label="Production order" value={order?.id ?? null} current={order?.id ? { id: order.id, orderNumber: order.name ?? "" } : undefined}
            onChange={(id, item) => setOrder(id ? { id, name: item?.name ?? order?.name } : null)} />
          <RHFComboBox label="Site" icon={HouseIcon} placeholder="All sites" options={(sites?.data ?? []).map((s) => ({ id: s.id, name: `${s.code} · ${s.name}` }))} value={site} onChange={setSite} />
          <RHFComboBox label="Machine" icon={FactoryIcon} placeholder="All machines" options={machineItems.map((m) => ({ id: m.id, name: `${m.code} · ${m.name}` }))} value={machine} onChange={setMachine} />
          <CustomFieldFilters entityType="inspection" />
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

export default InspectionFilterPane;
