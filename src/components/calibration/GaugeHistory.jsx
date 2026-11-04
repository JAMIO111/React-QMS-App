import { useGaugeHistory } from "../../hooks/useCalibration";
import { describeApiError } from "../../lib/api-client";
import { GAUGE_FIELD_LABELS, statusOf } from "../../lib/calibration";
import { formatDate } from "../../lib/ncr";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATES = new Set(["last_calibrated_on", "next_due_on", "commissioned_on"]);
// Stamps set alongside another change; the change itself says enough.
const HIDDEN = new Set(["updated_at", "updated_by", "deleted_by", "status_changed_at"]);

const formatValue = (field, value, names) => {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "status") return statusOf(value).label;
  if (field === "calibration_source") return value === "external" ? "External" : "In-house";
  if (DATES.has(field)) return formatDate(String(value).slice(0, 10));
  if (field.endsWith("_at")) return new Date(value).toLocaleString("en-GB");
  if (typeof value === "string" && UUID.test(value)) return names?.[value] ?? "a record you cannot see";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
};

/** Who changed the gauge or its characteristics, and how (before → after). */
const GaugeHistory = ({ id }) => {
  const { data, isLoading, error } = useGaugeHistory(id);
  if (isLoading) return <p className="text-secondary-text">Loading history…</p>;
  if (error) return <p role="alert" className="text-error-color">{describeApiError(error)}</p>;
  if (!data?.length) return <p className="text-secondary-text">No changes recorded yet.</p>;
  return (
    <ol className="flex flex-col gap-3">
      {[...data].reverse().map((e) => {
        const isChar = e.entityType === "gauge_characteristics";
        const what = isChar ? `characteristic “${e.current?.name ?? e.previous?.name ?? ""}”` : "the gauge";
        const fields = e.action === "insert" ? [] : e.changedFields.filter((f) => !HIDDEN.has(f));
        return (
          <li key={e.id} className="rounded-xl border border-border-color bg-secondary-bg p-3 text-sm">
            <p className="text-primary-text">
              <strong>{e.actor?.name ?? "System"}</strong> {e.action === "insert" ? `added ${what}` : `changed ${what}`}{" "}
              <span className="text-secondary-text">· {new Date(e.at).toLocaleString("en-GB")}</span>
              {e.reason && <span className="text-secondary-text"> · “{e.reason}”</span>}
            </p>
            {fields.length > 0 && (
              <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-secondary-text">
                {fields.map((f) =>
                  f === "deleted_at" ? (
                    <li key={f}>{e.current?.deleted_at ? "Deleted" : "Restored"}</li>
                  ) : (
                    <li key={f}>
                      {GAUGE_FIELD_LABELS[f] ?? f}: <span className="line-through decoration-secondary-text/60">{formatValue(f, e.previous?.[f], e.names)}</span> →{" "}
                      <span className="font-medium text-primary-text">{formatValue(f, e.current?.[f], e.names)}</span>
                    </li>
                  )
                )}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
};

export default GaugeHistory;
