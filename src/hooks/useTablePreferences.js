import { useCallback, useEffect, useState } from "react";

const PREFIX = "qms.table.";
const EMPTY = { columnVisibility: {}, columnSizing: {}, columnOrder: [] };

const load = (key) => {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw);
    const clean = (obj, type) =>
      Object.fromEntries(Object.entries(obj && typeof obj === "object" ? obj : {}).filter(([, v]) => typeof v === type));
    const order = Array.isArray(parsed.columnOrder) ? parsed.columnOrder.filter((id) => typeof id === "string") : [];
    return { columnVisibility: clean(parsed.columnVisibility, "boolean"), columnSizing: clean(parsed.columnSizing, "number"), columnOrder: order };
  } catch {
    return EMPTY;
  }
};

const resolve = (updater, previous) => (typeof updater === "function" ? updater(previous) : updater);

/**
 * Column visibility, widths and order for one table, remembered in this browser under `key`
 * (e.g. "nc-register:Internal"). The setters accept TanStack updaters, so they can be passed
 * straight to useReactTable as onColumnVisibilityChange / onColumnSizingChange.
 */
export function useTablePreferences(key) {
  const [state, setState] = useState(() => ({ key, ...load(key) }));
  // A different table (key) loads its own preferences.
  const current = state.key === key ? state : { key, ...load(key) };
  if (current !== state) setState(current);

  const setColumnVisibility = useCallback(
    (updater) => setState((s) => ({ ...s, columnVisibility: resolve(updater, s.columnVisibility) })),
    []
  );
  const setColumnSizing = useCallback(
    (updater) => setState((s) => ({ ...s, columnSizing: resolve(updater, s.columnSizing) })),
    []
  );
  const setColumnOrder = useCallback(
    (updater) => setState((s) => ({ ...s, columnOrder: resolve(updater, s.columnOrder) })),
    []
  );
  const resetColumns = useCallback(() => setState((s) => ({ ...s, ...EMPTY })), []);

  useEffect(() => {
    try {
      const { columnVisibility, columnSizing, columnOrder } = current;
      if (!Object.keys(columnVisibility).length && !Object.keys(columnSizing).length && !columnOrder.length) localStorage.removeItem(PREFIX + key);
      else localStorage.setItem(PREFIX + key, JSON.stringify({ columnVisibility, columnSizing, columnOrder }));
    } catch {
      // Storage unavailable: preferences last for this page only.
    }
  }, [key, current]);

  return {
    columnVisibility: current.columnVisibility,
    setColumnVisibility,
    columnSizing: current.columnSizing,
    setColumnSizing,
    columnOrder: current.columnOrder ?? [],
    setColumnOrder,
    resetColumns,
  };
}
