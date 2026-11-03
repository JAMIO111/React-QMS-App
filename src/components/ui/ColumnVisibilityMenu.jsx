import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, Columns3Icon, RotateCcwIcon } from "@/components/icons";

const label = (col) => col.headerString ?? (typeof col.header === "string" ? col.header : col.id);

/**
 * Show / hide columns for a table. Works with TanStack's columnVisibility state
 * ({ [columnId]: false } hides a column), so it can sit anywhere on the page, not only beside the
 * table. Columns with enableHiding: false are not listed; the last visible column cannot be hidden.
 */
const ColumnVisibilityMenu = ({ columns, columnVisibility, onColumnVisibilityChange, onReset }) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 0 });
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  const hideable = columns.filter((c) => c.enableHiding !== false);
  const isVisible = (id) => columnVisibility?.[id] !== false;
  const visibleCount = hideable.filter((c) => isVisible(c.id)).length;

  const toggle = (id) => {
    const visible = isVisible(id);
    if (visible && visibleCount <= 1) return;
    onColumnVisibilityChange((prev) => ({ ...prev, [id]: !visible }));
  };

  const openMenu = () => {
    const rect = buttonRef.current.getBoundingClientRect();
    setPosition({ top: rect.bottom + window.scrollY + 6, right: Math.max(8, window.innerWidth - rect.right - window.scrollX) });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => {
      if (!buttonRef.current?.contains(e.target) && !menuRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    menuRef.current?.querySelector("button")?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hiddenCount = hideable.length - visibleCount;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Show or hide columns"
        onClick={() => (open ? setOpen(false) : openMenu())}
        className="relative flex h-8.5 items-center gap-1.5 rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-2 text-sm text-primary-text hover:border-neutral-btn-border-hover hover:bg-neutral-btn-bg-hover cursor-pointer">
        <Columns3Icon className="h-5 w-5" />
        <span className="sr-only">Columns</span>
        {hiddenCount > 0 && (
          <span className="rounded-full bg-cta-color px-1.5 text-xs text-white" aria-label={`${hiddenCount} hidden`}>
            {hiddenCount}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label="Columns"
            className="absolute z-[9999] flex min-w-48 flex-col rounded-lg border border-border-color bg-primary-bg p-1 shadow-lg shadow-shadow-color"
            style={{ top: position.top, right: position.right }}>
            {hideable.map((col) => {
              const visible = isVisible(col.id);
              const locked = visible && visibleCount <= 1;
              return (
                <button
                  key={col.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={visible}
                  aria-disabled={locked || undefined}
                  title={locked ? "At least one column must stay visible" : undefined}
                  onClick={() => toggle(col.id)}
                  className={`flex items-center justify-between gap-5 rounded px-3 py-1 text-left text-sm text-primary-text hover:bg-hover-menu-color ${
                    locked ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                  }`}>
                  {label(col)}
                  <CheckIcon className={`h-4 w-4 text-cta-color ${visible ? "opacity-100" : "opacity-0"}`} />
                </button>
              );
            })}
            {onReset && (
              <>
                <div className="my-1 border-t border-border-color" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onReset();
                    setOpen(false);
                  }}
                  className="flex items-center gap-2 rounded px-3 py-1 text-left text-sm text-secondary-text hover:bg-hover-menu-color cursor-pointer">
                  <RotateCcwIcon className="h-4 w-4" /> Reset columns
                </button>
              </>
            )}
          </div>,
          document.getElementById("modal-root") ?? document.body
        )}
    </>
  );
};

export default ColumnVisibilityMenu;
