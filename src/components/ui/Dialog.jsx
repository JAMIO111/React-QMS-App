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

  // Header and footer are sticky inside the scroll area, so the content slides behind them; they turn to translucent glass only while
  // something is actually scrolled behind them (data-scrolled / data-more on the scroll area, set without re-rendering).
  const scroller = useRef(null);
  const body = useRef(null);
  useEffect(() => {
    const el = scroller.current;
    const content = body.current;
    if (!el || !content) return undefined;
    const update = () => {
      el.toggleAttribute("data-scrolled", el.scrollTop > 2);
      el.toggleAttribute("data-more", el.scrollHeight - el.scrollTop - el.clientHeight > 2);
    };
    // The footer is the last block of the dialog's content when it holds only buttons (a form's last row, or the last row of a plain dialog).
    const markFooter = () => {
      const root = content.firstElementChild?.tagName === "FORM" ? content.firstElementChild : content;
      const last = root.lastElementChild;
      if (last && !last.hasAttribute("data-dialog-footer") && last.querySelector("button") && !last.querySelector("input, textarea, select")) last.setAttribute("data-dialog-footer", "");
    };
    markFooter();
    update();
    el.addEventListener("scroll", update, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resize?.observe(el);
    resize?.observe(content);
    const mutations = new MutationObserver(() => {
      markFooter();
      update();
    });
    mutations.observe(content, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", update);
      resize?.disconnect();
      mutations.disconnect();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`w-full ${width} overflow-hidden rounded-2xl border border-border-color bg-primary-bg shadow-lg shadow-shadow-color`}>
        <div ref={scroller} className="dialog-scroll max-h-[90vh] overflow-y-auto">
          <div className="dialog-head sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-3">
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
          <div ref={body} className="px-5 pb-5 pt-1" onSubmit={(e) => e.stopPropagation()}>
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.getElementById("modal-root") ?? document.body
  );
};

export default Dialog;
