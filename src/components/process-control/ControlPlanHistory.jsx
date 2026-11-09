import { useControlPlanHistory, REVISION_STATUS } from "../../hooks/useProcessControl";
import { describeApiError } from "../../lib/api-client";
import LoadingScreen from "../ui/LoadingScreen";
import Callout from "../ui/Callout";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Stamps set alongside another change; the change itself says enough.
const HIDDEN = new Set(["updated_at", "updated_by", "submitted_at", "submitted_by", "approved_at", "approved_by", "effective_until"]);
const LABELS = {
  plan_code: "Plan code",
  title: "Title",
  description: "Description",
  owner_id: "Owner",
  active: "Active",
  revision_code: "Revision",
  status: "Status",
  change_reason: "Reason for change",
  effective_from: "Effective from",
  review_comment: "Review comment",
  obsolete_reason: "Obsolete reason",
  part_id: "Part",
  site_id: "Site",
  operation_code: "Operation",
};

const formatValue = (field, value, names) => {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "status") return REVISION_STATUS[value]?.label ?? value;
  if (field.endsWith("_at") || field === "effective_from") return new Date(value).toLocaleString("en-GB");
  if (typeof value === "string" && UUID.test(value)) return names?.[value] ?? "a record you cannot see";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
};

const describe = (e) => {
  const v = e.current ?? e.previous ?? {};
  if (e.entityType === "control_plans") return "the plan";
  if (e.entityType === "control_plan_revisions") return v.revision_code ? `revision ${v.revision_code}` : e.names?.[e.entityId] ?? "a revision";
  const named = e.names?.[e.entityId];
  const scope = named ?? [e.names?.[v.part_family_id], e.names?.[v.part_id], e.names?.[v.site_id], v.operation_code].filter(Boolean).join(" · ");
  return `scope${scope ? ` ${scope}` : ""}`;
};

const verb = (action) => (action === "insert" ? "added" : action === "delete" ? "removed" : "changed");

/** Who changed the plan, its scope and its revisions, and how (before → after). */
const ControlPlanHistory = ({ id }) => {
  const { data, isLoading, error } = useControlPlanHistory(id);
  if (isLoading) return <LoadingScreen size="sm" />;
  if (error) return <Callout tone="error" role="alert">{describeApiError(error)}</Callout>;
  if (!data?.length) return <p className="text-secondary-text">No changes recorded yet.</p>;
  return (
    <ol className="flex flex-col gap-3">
      {[...data].reverse().map((e) => {
        const fields = e.action === "update" ? e.changedFields.filter((f) => !HIDDEN.has(f)) : [];
        return (
          <li key={e.id} className="rounded-xl border border-border-color bg-primary-bg p-3 text-sm">
            <p className="text-primary-text">
              <strong>{e.actor?.name ?? "System"}</strong> {verb(e.action)} {describe(e)}{" "}
              <span className="text-secondary-text">· {new Date(e.at).toLocaleString("en-GB")}</span>
              {e.reason && <span className="text-secondary-text"> · “{e.reason}”</span>}
            </p>
            {fields.length > 0 && (
              <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-secondary-text">
                {fields.map((f) => (
                  <li key={f}>
                    {LABELS[f] ?? f}: <span className="line-through decoration-secondary-text/60">{formatValue(f, e.previous?.[f], e.names)}</span> →{" "}
                    <span className="font-medium text-primary-text">{formatValue(f, e.current?.[f], e.names)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
};

export default ControlPlanHistory;
