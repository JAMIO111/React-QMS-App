import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Filters kept in the URL (so a filtered register can be bookmarked or shared). Returns the current
 * value of each key ("" when unset) and `updateFilters(values | updater)`; any change returns to page 1.
 */
export function useUrlFilters(keys) {
  const [searchParams, setSearchParams] = useSearchParams();
  const values = Object.fromEntries(keys.map((k) => [k, searchParams.get(k) || ""]));
  const keyList = keys.join(",");

  const updateFilters = useCallback(
    (next) => {
      const list = keyList.split(",");
      setSearchParams((prev) => {
        const current = Object.fromEntries(list.map((k) => [k, prev.get(k) || ""]));
        const merged = typeof next === "function" ? next(current) : { ...current, ...next };
        const params = new URLSearchParams(prev);
        let changed = false;
        list.forEach((k) => {
          const v = merged[k] ?? "";
          if (v !== current[k]) changed = true;
          if (v) params.set(k, v);
          else params.delete(k);
        });
        if (changed) params.delete("page");
        return params;
      });
    },
    [setSearchParams, keyList]
  );

  return { ...values, updateFilters };
}

/** Gauge register filters. */
export const GAUGE_FILTER_KEYS = ["search", "status", "due", "outcome", "type", "site", "supplier", "supplierLabel", "source", "from", "to", "deleted"];
export const useGaugeFilters = () => useUrlFilters(GAUGE_FILTER_KEYS);

/** In-process inspection register filters. */
export const INSPECTION_FILTER_KEYS = ["search", "status", "result", "trigger", "part", "partLabel", "site", "machine", "machineLabel", "from", "to"];
export const useInspectionFilters = () => useUrlFilters(INSPECTION_FILTER_KEYS);
