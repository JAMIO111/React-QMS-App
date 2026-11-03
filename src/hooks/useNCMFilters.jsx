import { useSearchParams } from "react-router-dom";
import { useCallback } from "react";

/** Register filters kept in the URL, so a filtered register can be bookmarked or shared. */
const KEYS = ["search", "stage", "failureMode", "subFailureMode", "deleted"];

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
