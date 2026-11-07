import { useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "@/components/icons";

/** Previous / next through the items of a pane: "2 of 5". Hidden when there is only one. */
export const Pager = ({ index, count, onChange, label }) =>
  count > 1 ? (
    <div className="flex items-center justify-between gap-2" role="group" aria-label={`${label} navigation`}>
      <button type="button" className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border-color text-primary-text hover:bg-primary-text/5 cursor-pointer" aria-label={`Previous ${label}`} onClick={() => onChange((index - 1 + count) % count)}>
        <ChevronLeftIcon className="h-5 w-5" />
      </button>
      <span aria-live="polite" className="text-sm tabular-nums text-secondary-text">
        {index + 1} of {count}
      </span>
      <button type="button" className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border-color text-primary-text hover:bg-primary-text/5 cursor-pointer" aria-label={`Next ${label}`} onClick={() => onChange((index + 1) % count)}>
        <ChevronRightIcon className="h-5 w-5" />
      </button>
    </div>
  ) : null;

/**
 * Launchers on the right edge of the job hub and the pane that slides in over the right side. One pane is open at a time; the page underneath stays
 * usable (no backdrop), so recording is never blocked. Each launcher shows a count and a dot when something needs the operator's attention.
 * panes: [{ key, label, icon, count, attention, content }]. Rendered inside a `relative overflow-hidden` parent.
 */
const SidePanes = ({ panes }) => {
  const [openKey, setOpenKey] = useState(null);
  const [shown, setShown] = useState(null); // keeps the content while the pane slides out
  const open = panes.find((p) => p.key === openKey);
  const content = panes.find((p) => p.key === (openKey ?? shown));

  useEffect(() => {
    if (!openKey) return undefined;
    const onKey = (e) => e.key === "Escape" && setOpenKey(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openKey]);

  const toggle = (key) => {
    setShown(key);
    setOpenKey((k) => (k === key ? null : key));
  };
  if (panes.length === 0) return null;

  return (
    <>
      <nav aria-label="Job information panes" className={`absolute top-1/3 z-30 flex flex-col gap-2 transition-[right] duration-300 ${open ? "right-[min(28rem,100%)]" : "right-0"}`}>
        {panes.map((p) => {
          const Icon = p.icon;
          const active = openKey === p.key;
          return (
            <button
              key={p.key}
              type="button"
              aria-label={`${p.label}${p.count === 0 ? ", none" : `, ${p.count}`}${p.attention ? ", needs attention" : ""}`}
              aria-expanded={active}
              aria-controls="job-pane"
              onClick={() => toggle(p.key)}
              className={`relative flex min-h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-l-xl border border-r-0 px-1 text-[11px] font-medium shadow-md cursor-pointer ${
                active ? "border-brand-primary bg-brand-primary text-white" : "border-border-color bg-secondary-bg text-primary-text hover:bg-primary-text/5"
              }`}>
              <Icon className="h-5 w-5" aria-hidden="true" />
              <span aria-hidden="true">{p.label}</span>
              {p.count > 0 && (
                <span aria-hidden="true" className={`absolute -left-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-semibold ${p.attention ? "bg-error-color text-white" : "bg-primary-text text-primary-bg"}`}>
                  {p.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <aside
        id="job-pane"
        role="complementary"
        aria-label={content ? `${content.label} pane` : "Job information"}
        inert={!open}
        className={`absolute inset-y-0 right-0 z-30 flex w-[min(28rem,100%)] flex-col border-l border-border-color bg-primary-bg shadow-xl transition-transform duration-300 ${open ? "translate-x-0" : "translate-x-full"}`}>
        {content && (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-border-color px-4 py-3">
              <h2 className="text-lg font-semibold text-primary-text">{content.title ?? content.label}</h2>
              <button type="button" aria-label="Close pane" onClick={() => setOpenKey(null)} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-primary-text hover:bg-primary-text/5 cursor-pointer">
                <XIcon className="h-5 w-5" />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">{content.content}</div>
          </>
        )}
      </aside>
    </>
  );
};

export default SidePanes;
