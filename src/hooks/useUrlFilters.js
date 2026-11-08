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
export const INSPECTION_FILTER_KEYS = ["search", "status", "result", "trigger", "part", "partLabel", "site", "machine", "machineLabel", "order", "orderLabel", "from", "to"];
export const useInspectionFilters = () => useUrlFilters(INSPECTION_FILTER_KEYS);

/** Employees register filters. */
export const EMPLOYEE_FILTER_KEYS = ["search", "status", "site", "department"];
export const useEmployeeFilters = () => useUrlFilters(EMPLOYEE_FILTER_KEYS);

/** Audits register filters. */
export const AUDIT_FILTER_KEYS = ["search", "status", "type", "machine", "machineLabel"];
export const useAuditFilters = () => useUrlFilters(AUDIT_FILTER_KEYS);

/** Audit records register filters. */
export const AUDIT_RECORD_FILTER_KEYS = ["search", "status", "result", "audit", "auditLabel", "machine", "machineLabel", "mine", "from", "to"];
export const useAuditRecordFilters = () => useUrlFilters(AUDIT_RECORD_FILTER_KEYS);

/** Audit findings register filters. */
export const AUDIT_FINDING_FILTER_KEYS = ["search", "status", "classification", "kind", "owner", "ownerLabel", "audit", "auditLabel", "overdue"];
export const useAuditFindingFilters = () => useUrlFilters(AUDIT_FINDING_FILTER_KEYS);

/** Audit schedule filters: view (list | calendar), month (YYYY-MM; none = about a month either side of today), state, audit and machine. */
export const AUDIT_SCHEDULE_FILTER_KEYS = ["view", "month", "state", "audit", "auditLabel", "machine", "machineLabel"];
export const useAuditScheduleFilters = () => useUrlFilters(AUDIT_SCHEDULE_FILTER_KEYS);
