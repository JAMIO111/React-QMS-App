import { useSearchParams } from "react-router-dom";
import { useCallback } from "react";

/** Register filters kept in the URL, so a filtered register can be bookmarked or shared. */
export const FILTER_KEYS = [
  "search", "source", "category", "categoryLabel", "uncategorised", "stage", "severity", "failureMode", "subFailureMode", "deleted",
  "from", "to", "raisedFrom", "raisedTo", "costMin", "costMax", "qtyMin", "qtyMax",
  // Linked records keep their display name beside the id, for the active-filter chips.
  "part", "partLabel", "customer", "customerLabel", "supplier", "supplierLabel",
  "order", "orderLabel", "lot", "lotLabel", "department", "departmentLabel", "detectedBy", "detectedByLabel",
];
const KEYS = FILTER_KEYS;

export function useNCMFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const values = Object.fromEntries(KEYS.map((k) => [k, searchParams.get(k) || ""]));

  /** Merge new filter values (object or updater); any filter change returns to page 1. */
  const updateFilters = useCallback(
    (next) => {
      setSearchParams((prev) => {
        const current = Object.fromEntries(KEYS.map((k) => [k, prev.get(k) || ""]));
        const merged = typeof next === "function" ? next(current) : { ...current, ...next };
        const params = new URLSearchParams(prev);
        let changed = false;
        KEYS.forEach((k) => {
          const v = merged[k] ?? "";
          if (v !== current[k]) changed = true;
          if (v) params.set(k, v);
          else params.delete(k);
        });
        if (changed) params.delete("page");
        return params;
      });
    },
    [setSearchParams]
  );

  return { ...values, updateFilters };
}
