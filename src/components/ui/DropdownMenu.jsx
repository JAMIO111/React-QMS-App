import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import clsx from "clsx";

/**
 * The app's one dropdown menu: a button (or picture, or icon) that opens a small list of actions.
 *
 *   <DropdownMenu
 *     label="Account menu"                               // names the menu for screen readers
 *     header={<div>Jane Smith<br />jane@acme.com</div>}  // optional, not clickable
 *     items={[
 *       { label: "Open", icon: FolderOpenIcon, onSelect: () => … },
 *       { label: "Help", icon: CircleHelpIcon, href: "https://…" },        // external link, new tab
 *       { label: "Settings", icon: SettingsIcon, to: "/Settings" },        // in-app link
 *       { label: "Dark mode", icon: MoonStarIcon, checked, onSelect: toggle }, // a switch; stays open
 *       { separator: true },
 *       { label: "Delete", icon: Trash2Icon, tone: "danger", onSelect: … },
 *     ]}
 *     trigger={(props, { open }) => <button {...props}>…</button>}
 *   />
 *
 * Item fields: `label`, `icon`, `hint` (small text under the label), `tone: "danger"`, `disabled`, `checked` (a boolean makes it a switch),
 * `closeOnSelect` (default true, false for switches), and one of `onSelect`, `to` or `href`. Entries that are falsy are skipped, so
 * `can("x") && { … }` works. The list floats in a portal on `document.body` with `data-popover` (so dialogs and panes never clip it,
 * and panes that close on outside clicks can ignore it), opens below the trigger or above when there is no room, lines up with the
 * trigger's right edge (`align="start"` for the left), and follows it when the page scrolls or the window is resized.
 * Closes on an outside click, Escape (focus goes back to the trigger), Tab, or choosing an item. Arrow keys, Home and End move
 * between the items.
 */
const DropdownMenu = ({ trigger, items = [], header = null, label = "Menu", align = "end", width = 256 }) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const anchorRef = useRef(null);
  const popRef = useRef(null);
  const menuId = useId();

  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) anchorRef.current?.focus();
  }, []);

  // Place the list under the trigger (above when there is no room), and keep it there.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const height = popRef.current?.offsetHeight ?? 0;
      const roomBelow = window.innerHeight - rect.bottom;
      const up = height > 0 && roomBelow < height + 12 && rect.top > roomBelow;
      const wanted = align === "start" ? rect.left : rect.right - width;
      const left = Math.max(8, Math.min(wanted, window.innerWidth - width - 8));
      setPosition(up ? { left, bottom: window.innerHeight - rect.top + 6 } : { left, top: rect.bottom + 6 });
    };
    place();
    const onScroll = (e) => !popRef.current?.contains(e.target) && place();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open, align, width]);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return undefined;
    }
    const onPointerDown = (e) => {
      if (popRef.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return;
      close();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  // Keyboard: the first item gets focus when the list opens.
  useEffect(() => {
    if (!open || !position) return;
    if (popRef.current && !popRef.current.contains(document.activeElement)) {
      popRef.current.querySelector('[role^="menuitem"]:not([aria-disabled="true"])')?.focus();
    }
    // Only when the list first appears, not on every reposition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, position === null]);

  const entries = items.filter(Boolean);

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      close();
      return;
    }
    const enabled = [...popRef.current.querySelectorAll('[role^="menuitem"]:not([aria-disabled="true"])')];
    if (enabled.length === 0) return;
    const at = enabled.indexOf(document.activeElement);
    const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: enabled.length - 1 }[e.key];
    if (move === undefined) return;
    e.preventDefault();
    enabled[(move + enabled.length) % enabled.length].focus();
  };

  const triggerProps = {
    ref: anchorRef,
    type: "button",
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    onClick: () => setOpen((o) => !o),
    onKeyDown: (e) => {
      if (e.key === "ArrowDown" && !open) {
        e.preventDefault();
        setOpen(true);
      }
    },
  };

  return (
    <>
      {trigger(triggerProps, { open })}
      {open &&
        createPortal(
          <div
            ref={popRef}
            id={menuId}
            role="menu"
            aria-label={label}
            data-popover
            onKeyDown={onKeyDown}
            className="fixed z-[9500] flex flex-col gap-1 rounded-xl border border-border-color bg-secondary-bg p-2 shadow-lg"
            style={{ width, visibility: position ? "visible" : "hidden", ...(position ?? { top: 0, left: 0 }) }}>
            {header && <div className="px-2 pt-1 pb-2 border-b border-border-color mb-1">{header}</div>}
            {entries.map((item, i) =>
              item.separator ? (
                <div key={`sep-${i}`} role="separator" className="my-1 border-t border-border-color" />
              ) : (
                <MenuItem key={item.key ?? item.label} item={item} onDone={() => close(true)} />
              )
            )}
          </div>,
          document.body
        )}
    </>
  );
};

const MenuItem = ({ item, onDone }) => {
  const { label, icon: Icon, hint, tone, disabled = false, checked, onSelect, to, href } = item;
  const isSwitch = typeof checked === "boolean";
  const closeOnSelect = item.closeOnSelect ?? !isSwitch;
  const className = clsx(
    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left font-semibold transition-colors duration-200 outline-none",
    disabled
      ? "cursor-not-allowed opacity-50"
      : tone === "danger"
        ? "cursor-pointer text-error-text hover:bg-error-color/80 hover:text-white focus-visible:bg-error-color/80 focus-visible:text-white"
        : "cursor-pointer text-primary-text hover:bg-cta-color/70 hover:text-white focus-visible:bg-cta-color/70 focus-visible:text-white"
  );
  const body = (
    <>
      {Icon && <Icon className="h-5 w-5 shrink-0" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && <span className="block truncate text-xs font-normal opacity-80">{hint}</span>}
      </span>
      {isSwitch && (
        <span
          aria-hidden="true"
          className={clsx(
            "relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition-transform after:duration-200 after:content-['']",
            checked ? "bg-brand-primary after:translate-x-4" : "bg-border-color"
          )}
        />
      )}
    </>
  );
  const choose = () => {
    if (disabled) return;
    onSelect?.();
    if (closeOnSelect) onDone();
  };
  const common = {
    role: isSwitch ? "menuitemcheckbox" : "menuitem",
    "aria-checked": isSwitch ? checked : undefined,
    "aria-disabled": disabled || undefined,
    tabIndex: -1,
    className,
  };

  if (to && !disabled) {
    return (
      <Link {...common} to={to} onClick={choose}>
        {body}
      </Link>
    );
  }
  if (href && !disabled) {
    return (
      <a {...common} href={href} target="_blank" rel="noopener noreferrer" onClick={choose}>
        {body}
      </a>
    );
  }
  return (
    <button type="button" {...common} onClick={choose}>
      {body}
    </button>
  );
};

export default DropdownMenu;
