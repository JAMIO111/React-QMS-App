import { Link } from "react-router-dom";
import { useNcrHistory } from "../../hooks/useNcr";
import { describeApiError } from "../../lib/api-client";
import { FIELD_LABELS, SEVERITIES, formatDate, sourceLabel, stageOf } from "../../lib/ncr";
import LoadingScreen from "../ui/LoadingScreen";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_TEXT = new Set([
  "description",
  "requirement",
  "actual_result",
  "stage_reason",
  "delete_reason",
]);

/** One stored value as people read it: labels for stages and severities, names for linked records. */
const formatValue = (field, value, names) => {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "stage") return stageOf(value).label;
  if (field === "source") return sourceLabel(value);
  if (field === "severity")
    return SEVERITIES.find((s) => s.key === value)?.label ?? value;
  if (field === "detected_at") return formatDate(String(value).slice(0, 10));
  if (field.endsWith("_at")) return new Date(value).toLocaleString("en-GB");
  if (typeof value === "string" && UUID.test(value))
    return names?.[value] ?? "a record you cannot see";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
};

const Change = ({ field, entry }) => {
  const label = FIELD_LABELS[field] ?? field;
  const from = formatValue(field, entry.previous?.[field], entry.names);
  const to = formatValue(field, entry.current?.[field], entry.names);
  if (field === "deleted_at")
    return <li>{entry.current?.deleted_at ? "Deleted" : "Restored"}</li>;
  if (LONG_TEXT.has(field)) {
    return (
      <li>
        {label}:
        <div className="mt-1 grid gap-1 sm:grid-cols-2">
          <p className="whitespace-pre-wrap rounded-lg bg-primary-bg px-2 py-1">
            <span className="block text-xs">Before</span>
            <span className="text-primary-text">{from}</span>
          </p>
          <p className="whitespace-pre-wrap rounded-lg bg-primary-bg px-2 py-1">
            <span className="block text-xs">After</span>
            <span className="text-primary-text">{to}</span>
          </p>
        </div>
      </li>
    );
  }
  return (
    <li>
      {label}:{" "}
      <span className="line-through decoration-secondary-text/60">{from}</span>{" "}
      → <span className="font-medium text-primary-text">{to}</span>
    </li>
  );
};

// Stamps set alongside another change; the change itself says enough.
const HIDDEN = new Set(["updated_at", "updated_by", "closed_by", "deleted_by"]);

/** Readings of an inspection put on this NC: when it was raised from the inspection, or when more were added. */
const LinkedReadings = ({ entry: e }) => {
  const { kind, inspection, readings, hidden, wholeInspection } = e.linked;
  return (
    <li className="rounded-xl border border-border-color bg-secondary-bg p-3 text-sm">
      <p className="text-primary-text">
        <strong>{e.actor?.name ?? "System"}</strong>{" "}
        {kind === "raised"
          ? "raised this from inspection"
          : "added readings from inspection"}{" "}
        {inspection ? (
          <Link
            className="text-link-color hover:underline"
            to={`/Inspections/${inspection.id}`}
          >
            {inspection.reference}
          </Link>
        ) : (
          "an inspection you cannot see"
        )}{" "}
        <span className="text-secondary-text">
          · {new Date(e.at).toLocaleString("en-GB")}
        </span>
      </p>
      <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-secondary-text">
        {wholeInspection && (
          <li>Linked to the inspection as a whole (no single reading)</li>
        )}
        {readings.map((r) => (
          <li key={r.id}>
            {r.characteristic}, sample #{r.sampleNumber}:{" "}
            <span className="font-medium text-primary-text tabular-nums">
              {r.value}
            </span>
          </li>
        ))}
        {hidden > 0 && (
          <li>
            {hidden} reading{hidden === 1 ? "" : "s"} you cannot see
          </li>
        )}
      </ul>
    </li>
  );
};

/** Who changed what and when, with before and after values. */
const NcrHistory = ({ id }) => {
  const { data, isLoading, error } = useNcrHistory(id);
  if (isLoading) return <LoadingScreen size="sm" />;
  if (error)
    return (
      <p role="alert" className="text-error-color">
        {describeApiError(error)}
      </p>
    );
  return (
    <ol className="flex flex-col gap-3">
      {data.map((e) => {
        if (e.action === "readings_linked" && e.linked)
          return <LinkedReadings key={e.id} entry={e} />;
        const fields =
          e.action === "insert"
            ? []
            : e.changedFields.filter((f) => !HIDDEN.has(f));
        return (
          <li
            key={e.id}
            className="rounded-xl border border-border-color bg-secondary-bg p-3 text-sm"
          >
            <p className="text-primary-text">
              <strong>{e.actor?.name ?? "System"}</strong>{" "}
              {e.action === "insert" ? "created this record" : "changed"}{" "}
              <span className="text-secondary-text">
                · {new Date(e.at).toLocaleString("en-GB")}
              </span>
              {e.reason && (
                <span className="text-secondary-text"> · “{e.reason}”</span>
              )}
            </p>
            {fields.length > 0 && (
              <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-secondary-text">
                {fields.map((f) => (
                  <Change key={f} field={f} entry={e} />
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
};

export default NcrHistory;
