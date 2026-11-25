import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QrCodeIcon, UsersIcon, XIcon } from "@/components/icons";
import { PPAP_FILTER_KEYS, usePpapFilters } from "../../hooks/useUrlFilters";
import { LEVELS, PPAP_STATUS, REASONS, levelLabel } from "../../lib/ppap";
import { PartPicker, PartyPicker } from "../ncr/Pickers";
import CTAButton from "@/components/CTAButton";

const STATUS_OPTIONS = Object.entries(PPAP_STATUS).map(([key, v]) => ({ key, label: v.label }));
const LEVEL_OPTIONS = LEVELS.map((l) => ({ key: String(l), label: levelLabel(l) }));
const REASON_OPTIONS = REASONS.map((r) => ({ key: r.value, label: r.label }));

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
 * PPAP register filters (kept in the URL) in the same right-hand drawer as the other registers: status (none chosen = those not withdrawn or rejected), level,
 * reason, a customer, a part and "only mine". Choices apply with "Apply".
 */
const PpapFilterPane = ({ onClose }) => {
  const filters = usePpapFilters();
  const list = (v) => (v ? v.split(",") : []);
  const [statuses, setStatuses] = useState(list(filters.status).filter((s) => s !== "all" && s !== "live"));
  const [levels, setLevels] = useState(list(filters.level));
  const [reasons, setReasons] = useState(list(filters.reason));
  const [customer, setCustomer] = useState(filters.customer ? { id: filters.customer, name: filters.customerLabel ?? "" } : null);
  const [part, setPart] = useState(filters.part ? { id: filters.part, name: filters.partLabel ?? "" } : null);
  const [mine, setMine] = useState(filters.owner === "me");
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
      status: statuses.join(","),
      level: levels.join(","),
      reason: reasons.join(","),
      customer: customer?.id ?? "",
      customerLabel: customer?.id ? customer.name : "",
      part: part?.id ?? "",
      partLabel: part?.id ? part.name : "",
      owner: mine ? "me" : "",
    });
  const resetAll = () => apply(Object.fromEntries(PPAP_FILTER_KEYS.filter((k) => k !== "search").map((k) => [k, ""])));

  return createPortal(
    <div className="fixed inset-0 z-[9000]">
      <div aria-hidden="true" onMouseDown={close} className={`absolute inset-0 bg-black/30 ${closing ? "animate-out fade-out" : "animate-in fade-in"} duration-200 fill-mode-forwards`} />
      <aside
        ref={paneRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Filter PPAP submissions"
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
          <Pills legend="Status" options={STATUS_OPTIONS} selected={statuses} onToggle={toggle(setStatuses)} none="Those not withdrawn or rejected" />
          <Pills legend="Level" options={LEVEL_OPTIONS} selected={levels} onToggle={toggle(setLevels)} none="Any level" />
          <Pills legend="Reason" options={REASON_OPTIONS} selected={reasons} onToggle={toggle(setReasons)} none="Any reason" />
          <PartyPicker
            label="Customer"
            kind="customers"
            icon={UsersIcon}
            value={customer?.id ?? null}
            current={customer?.id ? { id: customer.id, name: customer.name ?? "" } : undefined}
            onChange={(id, item) => setCustomer(id ? { id, name: item?.name ?? customer?.name ?? "" } : null)}
          />
          <PartPicker
            label="Part number"
            icon={QrCodeIcon}
            value={part?.id ?? null}
            current={part?.id ? { id: part.id, partNumber: part.name ?? "" } : undefined}
            onChange={(id, item) => setPart(id ? { id, name: item?.name ?? part?.name ?? "" } : null)}
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only submissions I own
          </label>
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

export default PpapFilterPane;
