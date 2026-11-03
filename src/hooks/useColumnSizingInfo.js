import { useCallback, useRef, useState } from "react";

const INITIAL = {
  startOffset: null,
  startSize: null,
  deltaOffset: null,
  deltaPercentage: null,
  isResizingColumn: false,
  columnSizingStart: [],
};

/**
 * TanStack's in-progress resize state, applied eagerly.
 *
 * When a page controls `columnSizing` itself (to save widths), TanStack computes the new widths
 * inside its columnSizingInfo updater and reads them in the columnSizing updater. React runs the
 * page's (parent) update first, so widths lag one mouse move behind. Resolving this updater
 * immediately fixes the order. Pass both values to useReactTable:
 *
 *   const sizingInfo = useColumnSizingInfo();
 *   useReactTable({ state: { columnSizingInfo: sizingInfo.columnSizingInfo, ... },
 *                   onColumnSizingInfoChange: sizingInfo.onColumnSizingInfoChange, ... })
 */
export function useColumnSizingInfo() {
  const latest = useRef(INITIAL);
  const [columnSizingInfo, setColumnSizingInfo] = useState(INITIAL);
  const onColumnSizingInfoChange = useCallback((updater) => {
    latest.current = typeof updater === "function" ? updater(latest.current) : updater;
    setColumnSizingInfo(latest.current);
  }, []);
  return { columnSizingInfo, onColumnSizingInfoChange };
}
