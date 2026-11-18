import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "@/components/icons";
import CTAButton from "../CTAButton";
import DateRangeFilter from "../ui/DateRangeFilter";
import { list } from "../../lib/portalRegister";

/**
 * The portal registers' filter drawer, the main app's own (`FilterPane`): it slides in from the right edge of the window over a dimmed page, scrolls on
 * its own with Apply / Reset all pinned at the bottom, and slides away on Apply, Escape, the backdrop or the close button (the last three without applying).
 * Choices are held here until Apply, so the register behind does not move while they are being made. `filters` are the register's declared filters.
 */
const draftFrom = (filters, params) =>
  Object.fromEntries(
    filters.map((f) => [
      f.key,
      f.type === "pills" ? list(params.get(`f.${f.key}`)) : f.type === "dates" ? { from: params.get(`d.${f.key}.from`) || null, to: params.get(`d.${f.key}.to`) || null } : params.get(`s.${f.key}`) === "1",
    ]),
  );
const emptyDraft = (filters) => Object.fromEntries(filters.map((f) => [f.key, f.type === "pills" ? [] : f.type === "dates" ? { from: null, to: null } : false]));

export default function PortalFilterPane({ filters, params, noun, onApply, onClose }) {
  const [draft, setDraft] = useState(() => draftFrom(filters, params));
  const [closing, setClosing] = useState(false);
  const paneRef = useRef(null);
  const closeRef = useRef(null);

  // Slide out, then let the page remove the drawer.
  const close = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => onClose?.(), 180);
  };
  closeRef.current = close;

  useEffect(() => {
    // An Escape already used to close a date picker inside the pane leaves the pane open.
    const onKey = (e) => e.key === "Escape" && !e.defaultPrevented && closeRef.current();
    document.addEventListener("keydown", onKey);
    paneRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const apply = (values) => {
    onApply(values);
    close();
  };
  const toggle = (key, value) =>
    setDraft((d) => ({ ...d, [key]: d[key].includes(value) ? d[key].filter((v) => v !== value) : [...d[key], value] }));

  return createPortal(
    <div className="fixed inset-0 z-[9000]">
      <div aria-hidden="true" onMouseDown={close} className={`absolute inset-0 bg-black/30 ${closing ? "animate-out fade-out" : "animate-in fade-in"} duration-200 fill-mode-forwards`} />
      <aside
        ref={paneRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Filter ${noun}`}
        className={`absolute inset-y-0 right-0 flex h-dvh w-96 max-w-full flex-col border-l border-border-color bg-primary-bg text-primary-text shadow-2xl shadow-shadow-color outline-none ${
          closing ? "animate-out slide-out-to-right" : "animate-in slide-in-from-right"
        } duration-200 ease-out fill-mode-forwards`}>
        <div className="flex shrink-0 flex-row items-center justify-between border-b border-border-color bg-secondary-bg px-4 py-3">
          <h3 className="text-xl">Filter</h3>
          <button type="button" aria-label="Close filters" className="cursor-pointer rounded-md p-1 hover:bg-primary-bg hover:text-error-color" onClick={close}>
            <XIcon />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          {filters.map((f) => {
            if (f.type === "pills") {
              const chosen = draft[f.key];
              return (
                <fieldset key={f.key}>
                  <legend className="text-sm font-medium">{f.label}</legend>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {f.options.map((o) => {
                      const on = chosen.includes(o.key);
                      return (
                        <label key={o.key} className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs ${on ? "border-brand-primary bg-brand-primary text-white" : "border-border-color hover:bg-border-color/40"}`}>
                          <input type="checkbox" className="sr-only" checked={on} onChange={() => toggle(f.key, o.key)} />
                          {o.label}
                        </label>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-xs text-secondary-text">{chosen.length ? `${chosen.length} selected` : `Any ${f.label.toLowerCase()}`}</p>
                </fieldset>
              );
            }
            if (f.type === "dates") {
              return (
                <DateRangeFilter key={f.key} label={f.label} direction={f.direction} from={draft[f.key].from} to={draft[f.key].to} onChange={(r) => setDraft((d) => ({ ...d, [f.key]: { from: r.from, to: r.to } }))} />
              );
            }
            return (
              <label key={f.key} className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" checked={draft[f.key]} onChange={() => setDraft((d) => ({ ...d, [f.key]: !d[f.key] }))} />
                {f.label}
              </label>
            );
          })}
        </div>
        <div className="flex shrink-0 justify-between gap-2 border-t border-border-color bg-secondary-bg px-4 py-3">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={() => apply(emptyDraft(filters))}>
            Reset all
          </CTAButton>
          <CTAButton buttonType="button" type="main" size="md" onClick={() => apply(draft)}>
            Apply
          </CTAButton>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
