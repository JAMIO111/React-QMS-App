import { useCallback, useEffect, useState } from "react";

const PREFIX = "qms.table.";
const EMPTY = { columnVisibility: {}, columnSizing: {} };

const load = (key) => {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw);
    const clean = (obj, type) =>
      Object.fromEntries(Object.entries(obj && typeof obj === "object" ? obj : {}).filter(([, v]) => typeof v === type));
    return { columnVisibility: clean(parsed.columnVisibility, "boolean"), columnSizing: clean(parsed.columnSizing, "number") };
  } catch {
    return EMPTY;
  }
};

const resolve = (updater, previous) => (typeof updater === "function" ? updater(previous) : updater);

/**
 * Column visibility and widths for one table, remembered in this browser under `key`
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
  const resetColumns = useCallback(() => setState((s) => ({ ...s, ...EMPTY })), []);

  useEffect(() => {
    try {
      const { columnVisibility, columnSizing } = current;
      if (!Object.keys(columnVisibility).length && !Object.keys(columnSizing).length) localStorage.removeItem(PREFIX + key);
      else localStorage.setItem(PREFIX + key, JSON.stringify({ columnVisibility, columnSizing }));
    } catch {
      // Storage unavailable: preferences last for this page only.
    }
  }, [key, current]);

  return {
    columnVisibility: current.columnVisibility,
    setColumnVisibility,
    columnSizing: current.columnSizing,
    setColumnSizing,
    resetColumns,
  };
}
