import CustomFieldFilters from "../custom-fields/CustomFieldFilters";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FactoryIcon, HouseIcon, XIcon } from "@/components/icons";
import { useAllDepartments, useSites } from "../../hooks/useQmsApi";
import { EMPLOYEE_FILTER_KEYS, useEmployeeFilters } from "../../hooks/useUrlFilters";
import RHFComboBox from "../ui/RHFComboBox";
import CTAButton from "@/components/CTAButton";

const STATUS_OPTIONS = [
  { key: "active", label: "Active" },
  { key: "inactive", label: "Inactive" },
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

/** Employees register filters (kept in the URL), in the same right-hand drawer as the other registers: status, site and department. */
const EmployeeFilterPane = ({ onClose }) => {
  const filters = useEmployeeFilters();
  const { data: sites } = useSites({ includeInactive: true });
  const { data: departments } = useAllDepartments({ includeInactive: true });
  const [statuses, setStatuses] = useState(filters.status ? filters.status.split(",") : []);
  const [site, setSite] = useState(filters.site || null);
  const [department, setDepartment] = useState(filters.department || null);
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

  const allDepartments = departments?.data ?? [];
  const departmentOptions = allDepartments.filter((d) => !site || d.siteId === site).map((d) => ({ id: d.id, name: `${d.code} · ${d.name}` }));
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
        aria-label="Filter employees"
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
          <Pills legend="Status" options={STATUS_OPTIONS} selected={statuses} onToggle={(k) => setStatuses((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]))} />
          <RHFComboBox
            label="Site"
            icon={HouseIcon}
            placeholder="All sites"
            options={(sites?.data ?? []).map((s) => ({ id: s.id, name: `${s.code} · ${s.name}` }))}
            value={site}
            onChange={(v) => {
              setSite(v);
              if (v && department && allDepartments.find((d) => d.id === department)?.siteId !== v) setDepartment(null);
            }}
          />
          <RHFComboBox label="Department" icon={FactoryIcon} placeholder="All departments" options={departmentOptions} value={department} onChange={setDepartment} />
          <CustomFieldFilters entityType="employee" />
        </div>
        <div className="flex shrink-0 justify-between gap-2 border-t border-border-color bg-secondary-bg px-4 py-3">
          <CTAButton
            buttonType="button"
            type="neutral" size="md"
            onClick={() => apply(Object.fromEntries(EMPLOYEE_FILTER_KEYS.filter((k) => k !== "search").map((k) => [k, ""])))}>
            Reset all
          </CTAButton>
          <CTAButton
            buttonType="button"
            type="main" size="md"
            onClick={() => apply({ status: statuses.join(","), site: site ?? "", department: department ?? "" })}>
            Apply
          </CTAButton>
        </div>
      </aside>
    </div>,
    document.body
  );
};

export default EmployeeFilterPane;
