import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PlusIcon } from "@/components/icons";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import { usePermissions } from "../../hooks/useQmsApi";
import { useQualityAlerts } from "../../hooks/useDocumentation";
import { CATEGORIES, SEVERITIES, categoryLabel, formatDay, referenceText } from "../../lib/qualityAlerts";
import { ErrorNotice, SelectField, buttonClass } from "../master-data/shared";
import { SeverityBadge, StatusPill } from "./shared";

const th = "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2 align-top";
const STATUS_OPTIONS = [
  { value: "draft", label: "Drafts" },
  { value: "active", label: "Active" },
  { value: "expired", label: "Expired" },
  { value: "withdrawn", label: "Withdrawn" },
  { value: "superseded", label: "Superseded revisions" },
];

/**
 * Quality alerts: communications that something needs immediate attention. The register lists the newest revision of each
 * alert; the filters narrow by lifecycle, category and severity. Filters live in the URL.
 */
const QualityAlertsPage = () => {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const manage = can("documentation.manage");
  const filters = { status: params.get("status") ?? "", category: params.get("category") ?? "", severity: params.get("severity") ?? "", q: params.get("q") ?? "", ...(manage && params.get("overdue") === "true" ? { overdue: "true" } : {}) };
  const query = useQualityAlerts(filters);
  const set = (patch) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
      return next;
    });
  const alerts = query.data?.data ?? [];

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">Quality alerts</h1>
          <p className="text-sm text-secondary-text">Communications that need immediate attention. Each is numbered, dated, kept in revisions and addressed to the people who must act on it.</p>
        </div>
        {manage && (
          <button type="button" className={`${buttonClass.primary} inline-flex items-center gap-1`} onClick={() => navigate("/Documentation/Quality-Alerts/new")}>
            <PlusIcon className="h-4 w-4" /> New quality alert
          </button>
        )}
      </div>

      <MenuCard title="Register" subtitle={query.data ? `${alerts.length} shown` : undefined}>
        {manage && (
          <label className="mb-3 flex items-center gap-2 text-sm text-primary-text">
            <input type="checkbox" checked={filters.overdue === "true"} onChange={(e) => set({ overdue: e.target.checked ? "true" : "" })} />
            Only alerts with overdue acknowledgements
          </label>
        )}
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search" value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder="Title or QA number" maxLength={100} />
          <SelectField label="Status" value={filters.status || null} onChange={(v) => set({ status: v ?? "" })} options={STATUS_OPTIONS} placeholder="Latest revision of each" />
          <SelectField label="Category" value={filters.category || null} onChange={(v) => set({ category: v ?? "" })} options={CATEGORIES} placeholder="All categories" />
          <SelectField label="Severity" value={filters.severity || null} onChange={(v) => set({ severity: v ?? "" })} options={SEVERITIES} placeholder="All severities" />
        </div>
        {query.isLoading && <p className="text-secondary-text">Loading quality alerts…</p>}
        {query.error && <ErrorNotice error={query.error} />}
        {query.data && alerts.length === 0 && <p className="text-sm text-primary-text">No quality alerts match.</p>}
        {alerts.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-separate border-spacing-0 text-sm text-primary-text" aria-label="Quality alerts">
              <thead>
                <tr>
                  <th scope="col" className={th}>Alert</th>
                  <th scope="col" className={th}>Title</th>
                  <th scope="col" className={th}>Category</th>
                  <th scope="col" className={th}>Severity</th>
                  <th scope="col" className={th}>Status</th>
                  <th scope="col" className={th}>Effective</th>
                  <th scope="col" className={th}>Expires</th>
                  {manage && <th scope="col" className={th}>Acknowledged</th>}
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id}>
                    <td className={`${td} whitespace-nowrap`}>
                      <Link to={`/Documentation/Quality-Alerts/${a.id}`} className="font-medium text-link-color hover:underline">
                        {referenceText(a)}
                      </Link>
                    </td>
                    <td className={td}>{a.title}</td>
                    <td className={td}>{categoryLabel(a.category)}</td>
                    <td className={td}><SeverityBadge severity={a.severity} /></td>
                    <td className={td}><StatusPill alert={a} /></td>
                    <td className={`${td} whitespace-nowrap`}>{formatDay(a.effectiveDate)}</td>
                    <td className={`${td} whitespace-nowrap`}>{formatDay(a.expiryDate)}</td>
                    {manage && (
                      <td className={`${td} whitespace-nowrap`}>
                        {a.progress && a.progress.total > 0 ? (
                          <span>
                            {a.progress.acknowledged} of {a.progress.total}
                            {a.progress.overdue > 0 && <span className="ml-1 font-medium text-error-color">· {a.progress.overdue} overdue</span>}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </MenuCard>
    </div>
  );
};

export default QualityAlertsPage;
