import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon, ChevronUpIcon, Columns3Icon, GripVerticalIcon, RotateCcwIcon } from "@/components/icons";
import { applyOrder, moveColumn, shiftColumn } from "../../lib/columnOrder";

const label = (col) => col.headerString ?? (typeof col.header === "string" ? col.header : col.id);

/**
 * Show, hide and reorder a table's columns. Works with TanStack's columnVisibility state
 * ({ [columnId]: false } hides a column) and, when given, columnOrder (an array of ids), so it can
 * sit anywhere on the page. Columns with enableHiding: false are not listed; the last visible
 * column cannot be hidden. Reorder by dragging a row's handle or with Move up / Move down.
 */
const ColumnVisibilityMenu = ({ columns, columnVisibility, onColumnVisibilityChange, columnOrder, onColumnOrderChange, onReset }) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 0 });
  const [drag, setDrag] = useState(null); // { from, over, after }
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();
  const canReorder = typeof onColumnOrderChange === "function";

  const allIds = columns.map((c) => c.id);
  const byId = Object.fromEntries(columns.map((c) => [c.id, c]));
  const ordered = applyOrder(allIds, columnOrder);
  const hideable = ordered.map((id) => byId[id]).filter((c) => c.enableHiding !== false);
  const listed = hideable.map((c) => c.id);
  const isVisible = (id) => columnVisibility?.[id] !== false;
  const visibleCount = hideable.filter((c) => isVisible(c.id)).length;

  const toggle = (id) => {
    const visible = isVisible(id);
    if (visible && visibleCount <= 1) return;
    onColumnVisibilityChange((prev) => ({ ...prev, [id]: !visible }));
  };
  const shift = (id, delta) => onColumnOrderChange(shiftColumn(ordered, id, delta, listed));

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
    menuRef.current?.querySelector("input")?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hiddenCount = hideable.length - visibleCount;
  const iconButton = "rounded p-0.5 text-secondary-text hover:bg-hover-menu-color hover:text-primary-text disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={canReorder ? "Show, hide or reorder columns" : "Show or hide columns"}
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
            role="dialog"
            aria-label="Columns"
            className="absolute z-[9999] flex min-w-60 flex-col rounded-lg border border-border-color bg-primary-bg p-1 shadow-lg shadow-shadow-color"
            style={{ top: position.top, right: position.right }}>
            <p className="px-2 pb-1 pt-0.5 text-xs text-secondary-text">{canReorder ? "Show, hide and drag to reorder" : "Show or hide"}</p>
            <ul className="flex max-h-[60vh] flex-col overflow-y-auto">
              {hideable.map((col, i) => {
                const visible = isVisible(col.id);
                const locked = visible && visibleCount <= 1;
                const target = drag && drag.over === col.id && drag.from !== col.id;
                return (
                  <li
                    key={col.id}
                    data-column-id={col.id}
                    draggable={canReorder || undefined}
                    onDragStart={
                      canReorder
                        ? (e) => {
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", col.id);
                            setDrag({ from: col.id, over: null, after: false });
                          }
                        : undefined
                    }
                    onDragOver={
                      canReorder && drag
                        ? (e) => {
                            e.preventDefault();
                            const r = e.currentTarget.getBoundingClientRect();
                            const after = e.clientY > r.top + r.height / 2;
                            if (drag.over !== col.id || drag.after !== after) setDrag({ ...drag, over: col.id, after });
                          }
                        : undefined
                    }
                    onDrop={
                      canReorder && drag
                        ? (e) => {
                            e.preventDefault();
                            onColumnOrderChange(moveColumn(ordered, drag.from, col.id, drag.after));
                            setDrag(null);
                          }
                        : undefined
                    }
                    onDragEnd={canReorder ? () => setDrag(null) : undefined}
                    className={`flex items-center gap-1 rounded px-1 text-sm text-primary-text hover:bg-hover-menu-color ${drag?.from === col.id ? "opacity-50" : ""} ${
                      target ? (drag.after ? "shadow-[inset_0_-2px_0_var(--brand-primary)]" : "shadow-[inset_0_2px_0_var(--brand-primary)]") : ""
                    }`}>
                    {canReorder && <GripVerticalIcon className="h-4 w-4 shrink-0 cursor-grab text-secondary-text" aria-hidden="true" />}
                    <label
                      className={`flex flex-1 items-center gap-2 py-1 pr-2 ${locked ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                      title={locked ? "At least one column must stay visible" : undefined}>
                      <input type="checkbox" checked={visible} disabled={locked} onChange={() => toggle(col.id)} className="accent-[var(--brand-primary)]" />
                      {label(col)}
                    </label>
                    {canReorder && (
                      <span className="flex">
                        <button type="button" aria-label={`Move ${label(col)} up`} disabled={i === 0} onClick={() => shift(col.id, -1)} className={iconButton}>
                          <ChevronUpIcon className="h-4 w-4" />
                        </button>
                        <button type="button" aria-label={`Move ${label(col)} down`} disabled={i === hideable.length - 1} onClick={() => shift(col.id, 1)} className={iconButton}>
                          <ChevronDownIcon className="h-4 w-4" />
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {onReset && (
              <>
                <div className="my-1 border-t border-border-color" role="separator" />
                <button
                  type="button"
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
