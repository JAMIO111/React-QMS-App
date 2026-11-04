import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "@/components/icons";

/**
 * Modal dialog: labelled by its title, closes on Escape or the close button, moves focus inside
 * when opened and back to the opener when closed.
 */
const Dialog = ({ title, onClose, children, width = "max-w-lg" }) => {
  const titleId = useId();
  const panel = useRef(null);
  // Callers usually pass an inline onClose; keep the latest without re-running the focus effect.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement;
    panel.current?.querySelector("input, select, textarea, button:not([data-dialog-close])")?.focus();
    const onKey = (e) => e.key === "Escape" && close.current();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`w-full ${width} max-h-[90vh] overflow-y-auto rounded-2xl border border-border-color bg-primary-bg p-5 shadow-lg shadow-shadow-color`}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold text-primary-text">
            {title}
          </h2>
          <button
            type="button"
            data-dialog-close
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-secondary-text hover:bg-hover-menu-color hover:text-primary-text cursor-pointer">
            <XIcon className="h-5 w-5" />
          </button>
        </div>
        {/* A dialog is portalled, but React still bubbles its events to the page's components:
            keep a dialog's form submit from also submitting a form the dialog was opened from. */}
        <div onSubmit={(e) => e.stopPropagation()}>{children}</div>
      </div>
    </div>,
    document.getElementById("modal-root") ?? document.body
  );
};

export default Dialog;
