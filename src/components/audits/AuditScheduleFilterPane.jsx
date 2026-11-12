import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardCheckIcon, FactoryIcon, ListChecksIcon, XIcon } from "@/components/icons";
import { useAuditScheduleFilters } from "../../hooks/useUrlFilters";
import { SLOT_STATES } from "../../lib/audits";
import RHFComboBox from "../ui/RHFComboBox";
import CTAButton from "@/components/CTAButton";

const STATE_OPTIONS = SLOT_STATES.map((s) => ({ id: s.value, name: s.label }));

/**
 * Audit schedule filters (kept in the URL), in the same right-hand drawer as the registers: which audit, which machine it is relevant to,
 * and how the slot stands. Choices apply with "Apply". The calendar shows every state, so the state only narrows the list.
 */
const AuditScheduleFilterPane = ({ onClose, audits = [], machines = [], view = "list" }) => {
  const filters = useAuditScheduleFilters();
  const [audit, setAudit] = useState(filters.audit || null);
  const [machine, setMachine] = useState(filters.machine || null);
  const [state, setState] = useState(filters.state || null);
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
        aria-label="Filter the audit schedule"
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
          <RHFComboBox label="Audit" icon={ClipboardCheckIcon} placeholder="Any audit" options={audits.map((a) => ({ id: a.id, name: `${a.reference} · ${a.title}` }))} value={audit} onChange={setAudit} />
          <RHFComboBox label="Machine" icon={FactoryIcon} placeholder="Any machine" hint="Audits that are relevant to this machine" options={machines.map((m) => ({ id: m.id, name: `${m.code} · ${m.name}` }))} value={machine} onChange={setMachine} />
          <RHFComboBox
            label="State"
            icon={ListChecksIcon}
            placeholder="Any state"
            sort={false}
            options={STATE_OPTIONS}
            value={state}
            onChange={setState}
            hint={view === "calendar" ? "The calendar shows every state; this narrows the list view." : undefined}
          />
        </div>
        <div className="flex shrink-0 justify-between gap-2 border-t border-border-color bg-secondary-bg px-4 py-3">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={() => apply({ audit: "", auditLabel: "", machine: "", machineLabel: "", state: "" })}>
            Reset all
          </CTAButton>
          <CTAButton buttonType="button" type="main" size="md" onClick={() => apply({ audit: audit ?? "", auditLabel: "", machine: machine ?? "", machineLabel: "", state: state ?? "" })}>
            Apply
          </CTAButton>
        </div>
      </aside>
    </div>,
    document.body
  );
};

export default AuditScheduleFilterPane;
