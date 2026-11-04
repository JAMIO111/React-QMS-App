import { useEffect, useRef, useState } from "react";
import { XIcon, TagIcon, TagsIcon, Trash2Icon, QrCodeIcon, UsersIcon } from "@/components/icons";
import { useNCMFilters } from "../hooks/useNCMFilters";
import { useClassifications, useNcrRanges } from "../hooks/useNcr";
import { SEVERITIES, STAGES } from "../lib/ncr";
import { formatMoney } from "../lib/costs";
import RHFComboBox from "./ui/RHFComboBox";
import RHFDatePickerPopout from "./ui/RHFDatePickerPopout";
import RangeSlider from "./ui/RangeSlider";
import { PartPicker, PartyPicker } from "./ncr/Pickers";

const DELETED_OPTIONS = [
  { id: "exclude", name: "Hide deleted" },
  { id: "include", name: "Include deleted" },
  { id: "only", name: "Only deleted" },
];

/** A slider's upper bound: the register's highest value rounded up to a tidy number. */
const niceMax = (n) => {
  if (!n || n <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(n));
  return Math.ceil(n / p) * p;
};
const num = (v) => (v === "" || v === null || v === undefined ? undefined : Number(v));

/** Pill multi-select (stages, severities). */
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
 * Register filters (kept in the URL): detected date, stage, severity, part, customer or supplier,
 * total cost and quantity ranges, failure mode, sub-failure mode and deleted records.
 * Choices apply with "Apply"; Escape or a click outside closes without applying.
 */
const FilterPane = ({ onClose, source }) => {
  const filters = useNCMFilters();
  const { data: lists } = useClassifications();
  const { data: ranges } = useNcrRanges(source);
  const list = (v) => (v ? v.split(",") : []);
  const [stages, setStages] = useState(list(filters.stage));
  const [severities, setSeverities] = useState(list(filters.severity));
  const [from, setFrom] = useState(filters.from || null);
  const [to, setTo] = useState(filters.to || null);
  const [part, setPart] = useState(filters.part ? { id: filters.part, name: filters.partLabel } : null);
  const partyKey = source === "supplier" ? "supplier" : "customer";
  const [party, setParty] = useState(filters[partyKey] ? { id: filters[partyKey], name: filters[`${partyKey}Label`] } : null);
  const [cost, setCost] = useState([num(filters.costMin), num(filters.costMax)]);
  const [qty, setQty] = useState([num(filters.qtyMin), num(filters.qtyMax)]);
  const [failureMode, setFailureMode] = useState(filters.failureMode || null);
  const [subFailureMode, setSubFailureMode] = useState(filters.subFailureMode || null);
  const [deleted, setDeleted] = useState(filters.deleted || "exclude");
  const paneRef = useRef(null);

  const currency = ranges?.baseCurrency ?? "GBP";
  // Keep a filter already applied inside the slider even if it is above the current maximum.
  const costMax = Math.max(niceMax(ranges?.cost.max), num(filters.costMax) ?? 0);
  const qtyMax = Math.max(niceMax(ranges?.quantity.max), num(filters.qtyMax) ?? 0);

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
      if (!(e.target instanceof Element)) return;
      // Inside the pane, on the Filter button, or in a popover the pane opened (date picker calendar).
      if (paneRef.current?.contains(e.target) || e.target.closest('[title="Filter"], [data-popover]')) return;
      onClose?.();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const toggle = (setter) => (key) => setter((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
  /** Range → URL values; an end left at its limit means "no limit". */
  const bound = ([lo, hi], max) => [lo !== undefined && lo > 0 ? String(lo) : "", hi !== undefined && max > 0 && hi < max ? String(hi) : ""];
  const apply = (values) => {
    filters.updateFilters(values);
    onClose?.();
  };
  const applyAll = () => {
    const [costMinV, costMaxV] = bound(cost, costMax);
    const [qtyMinV, qtyMaxV] = bound(qty, qtyMax);
    apply({
      stage: stages.join(","),
      severity: severities.join(","),
      from: from ?? "",
      to: to ?? "",
      part: part?.id ?? "",
      partLabel: part?.id ? part.name ?? "" : "",
      [partyKey]: party?.id ?? "",
      [`${partyKey}Label`]: party?.id ? party.name ?? "" : "",
      costMin: costMinV,
      costMax: costMaxV,
      qtyMin: qtyMinV,
      qtyMax: qtyMaxV,
      failureMode: failureMode ?? "",
      subFailureMode: subFailureMode ?? "",
      deleted: deleted === "exclude" ? "" : deleted,
    });
  };
  const resetAll = () =>
    apply(Object.fromEntries(["stage", "severity", "from", "to", "part", "partLabel", "customer", "customerLabel", "supplier", "supplierLabel",
      "costMin", "costMax", "qtyMin", "qtyMax", "failureMode", "subFailureMode", "deleted"].map((k) => [k, ""])));

  return (
    <div
      ref={paneRef}
      role="dialog"
      aria-label="Filter non-conformances"
      className="border absolute bg-primary-bg text-primary-text z-1000 top-32 right-4 flex max-h-[calc(100dvh-9rem)] flex-col rounded-2xl border-border-color shadow-lg shadow-shadow-color w-96 max-w-[calc(100vw-2rem)]">
      <div className="flex shrink-0 px-4 py-1 bg-secondary-bg border-b border-border-color flex-row justify-between items-center rounded-t-2xl">
        <h3 className="text-xl">Filter</h3>
        <button type="button" aria-label="Close filters" className="hover:bg-primary-bg rounded-md cursor-pointer hover:text-error-color p-1" onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 py-3">
        <div className="grid grid-cols-2 gap-2">
          <RHFDatePickerPopout label="Detected from" placeholder="Any date" valueFormat="iso" clearable value={from} onChange={setFrom} maxDate={to ?? new Date()} />
          <RHFDatePickerPopout label="Detected to" placeholder="Any date" valueFormat="iso" clearable value={to} onChange={setTo} minDate={from ?? undefined} maxDate={new Date()} />
        </div>
        <Pills legend="Stage" options={STAGES} selected={stages} onToggle={toggle(setStages)} />
        <Pills legend="Severity" options={SEVERITIES} selected={severities} onToggle={toggle(setSeverities)} />
        <PartPicker label="Part number" icon={QrCodeIcon} value={part?.id ?? null} current={part?.id ? { id: part.id, partNumber: part.name ?? "" } : undefined}
          onChange={(id, item) => setPart(id ? { id, name: item?.name ?? part?.name } : null)} />
        <PartyPicker kind={partyKey === "supplier" ? "suppliers" : "customers"} label={partyKey === "supplier" ? "Supplier" : "Customer"} icon={UsersIcon}
          value={party?.id ?? null} current={party?.id ? { id: party.id, name: party.name ?? "" } : undefined}
          onChange={(id, item) => setParty(id ? { id, name: item?.name ?? party?.name } : null)} />
        <RangeSlider
          label="Total cost"
          min={0}
          max={costMax || 1}
          step={costMax > 1000 ? 10 : 1}
          value={[cost[0] ?? 0, cost[1] ?? (costMax || 1)]}
          onChange={setCost}
          format={(n) => formatMoney(n, currency).replace(/\.00$/, "")}
          disabled={!costMax}
          hint={!costMax ? "No costs recorded in this register yet." : undefined}
        />
        <RangeSlider
          label="Quantity affected"
          min={0}
          max={qtyMax || 1}
          value={[qty[0] ?? 0, qty[1] ?? (qtyMax || 1)]}
          onChange={setQty}
          format={(n) => n.toLocaleString("en-GB")}
          disabled={!qtyMax}
          hint={!qtyMax ? "No quantities recorded in this register yet." : undefined}
        />
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
      <div className="flex shrink-0 justify-between gap-2 border-t border-border-color px-4 py-3">
        <button type="button" className="rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm hover:bg-neutral-btn-bg-hover cursor-pointer" onClick={resetAll}>
          Reset all
        </button>
        <button type="button" className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-3 py-1.5 text-sm hover:bg-cta-btn-bg-hover cursor-pointer" onClick={applyAll}>
          Apply
        </button>
      </div>
    </div>
  );
};

export default FilterPane;
