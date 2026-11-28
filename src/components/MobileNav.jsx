import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import Navbar from "./Navbar";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The phone's side menu: a drawer that slides in over the page from the menu button in the header (below the `md` width; the desktop and tablet rail
 * is untouched). It closes on Escape, on a tap outside it, on choosing a page and whenever the address changes, keeps keyboard focus inside while it is open
 * and gives focus back to the button that opened it.
 */
const MobileNav = ({ open, onClose }) => {
  const { pathname } = useLocation();
  const panel = useRef(null);
  const opener = useRef(null);

  // Whatever changes the address (a menu link, the command palette, the back button) closes it. Only a change: opening it must not.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    onClose();
  }, [pathname, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    opener.current = document.activeElement;
    panel.current?.querySelector("[data-autofocus]")?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden], [inert], [aria-hidden="true"]'));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 animate-in fade-in cursor-default bg-black/50 duration-200 motion-reduce:animate-none"
      />
      <div
        ref={panel}
        className="absolute inset-y-0 left-0 w-72 max-w-[85vw] animate-in slide-in-from-left bg-secondary-bg shadow-xl duration-200 motion-reduce:animate-none">
        <Navbar variant="drawer" onNavigate={onClose} />
      </div>
    </div>
  );
};

export default MobileNav;
