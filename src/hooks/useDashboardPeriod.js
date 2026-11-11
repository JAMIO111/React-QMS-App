import { useSearchParams } from "react-router-dom";
import { periodParams, readPeriod } from "@/lib/dashboardPeriod";

/**
 * The period of a dashboard, kept in the address (`?period=90d`, or `?from=…&to=…` for a custom range) so a view can be
 * bookmarked or shared. `defaultId` is the preset used when the address names none.
 * Returns { id, label, from, to (Dates), fromIso, toIso, setRange({ from, to }) }.
 */
export const useDashboardPeriod = (defaultId) => {
  const [params, setParams] = useSearchParams();
  const period = readPeriod(params, defaultId);
  const setRange = (range) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      ["period", "from", "to"].forEach((k) => next.delete(k));
      Object.entries(periodParams(range, defaultId)).forEach(([k, v]) => next.set(k, v));
      return next;
    });
  return { ...period, setRange };
};
