import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PlusIcon, ShieldAlertIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { usePermissions } from "../../hooks/useQmsApi";
import { useRiskCategories, useRisks } from "../../hooks/useRisk";
import { useUrlFilters } from "../../hooks/useUrlFilters";
import { BAND_OPTIONS, BAND_PILL, bandLabel, formatDay, kindLabel, RISK_KINDS, riskPath, STATUS_OPTIONS, statusLabel, statusPill } from "../../lib/risk";
import { ErrorNotice, SearchBox } from "../master-data/shared";
import ComboField from "../ui/ComboField";
import LoadingScreen from "../ui/LoadingScreen";
import SlidingToggle from "../ui/SlidingToggle";
import { RiskDialog } from "./RiskDialogs";

const RISK_FILTER_KEYS = ["search", "status", "kind", "band", "category", "owner", "overdue", "sort", "order", "page"];

const COLUMNS = [
  ["reference", "Reference"],
  ["title", "Title"],
  [null, "Kind"],
  ["category", "Category"],
  ["score", "Before treatment"],
  ["residual", "After treatment"],
  ["nextReview", "Next review"],
  ["owner", "Owner"],
  ["status", "Status"],
];

/** The risk register (`/Risk/Register`): risks and opportunities with where they stand before and after treatment and when they are next reviewed. Retired ones are left out unless asked for. */
const RiskRegisterPage = () => {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const f = useUrlFilters(RISK_FILTER_KEYS);
  const [creating, setCreating] = useState(false);
  const categories = useRiskCategories({ all: true });
  const page = Number(f.page) || 1;
  const sort = f.sort || "reference";
  const order = f.order || "asc";
  const risks = useRisks({ q: f.search, status: f.status, kind: f.kind, band: f.band, categoryId: f.category, owner: f.owner, reviewOverdue: f.overdue === "true" ? "true" : undefined, sort, order, page: f.page || undefined });
  const categoryOptions = (categories.data?.data ?? []).map((c) => ({ value: c.id, label: c.label, hint: c.active ? undefined : "Switched off" }));
  const filtered = f.search || f.status || f.kind || f.band || f.category || f.owner || f.overdue;
  const sortBy = (key) => f.updateFilters({ sort: key, order: sort === key && order === "asc" ? "desc" : "asc", page: "" });

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <ShieldAlertIcon className="h-6 w-6" aria-hidden="true" />
            Risk register
          </h1>
          <p className="text-sm text-secondary-text">What could go wrong, or better, how likely and how serious it is, and who looks after it.</p>
        </div>
        {can("risk.manage") && (
          <CTAButton buttonType="button" type="main" icon={PlusIcon} onClick={() => setCreating(true)}>
            Raise a risk
          </CTAButton>
        )}
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <SearchBox label="Search risks" onSearch={(v) => f.updateFilters({ search: v, page: "" })} />
        <div className="w-44">
          <ComboField label="Kind" value={f.kind || null} onChange={(v) => f.updateFilters({ kind: v ?? "", page: "" })} options={RISK_KINDS.map(({ value, label }) => ({ value, label }))} placeholder="Both" clearable />
        </div>
        <div className="w-48">
          <ComboField label="Level" value={f.band || null} onChange={(v) => f.updateFilters({ band: v ?? "", page: "" })} options={BAND_OPTIONS} placeholder="Any level" clearable />
        </div>
        <div className="w-52">
          <ComboField label="Category" value={f.category || null} onChange={(v) => f.updateFilters({ category: v ?? "", page: "" })} options={categoryOptions} placeholder="Every category" clearable />
        </div>
        <SlidingToggle ariaLabel="Owner" options={[{ value: "", label: "Everyone's" }, { value: "me", label: "Mine" }]} value={f.owner || ""} onChange={(v) => f.updateFilters({ owner: v, page: "" })} />
        <SlidingToggle ariaLabel="Review" options={[{ value: "", label: "Any review date" }, { value: "true", label: "Review overdue" }]} value={f.overdue || ""} onChange={(v) => f.updateFilters({ overdue: v, page: "" })} />
      </div>
      <SlidingToggle ariaLabel="Status" options={STATUS_OPTIONS} value={f.status || ""} onChange={(v) => f.updateFilters({ status: v, page: "" })} />

      {risks.isLoading ? (
        <LoadingScreen />
      ) : risks.error ? (
        <ErrorNotice error={risks.error} />
      ) : risks.data.data.length === 0 ? (
        <p className="text-sm text-secondary-text">{filtered ? "No risks match." : "Nothing in the register yet."}</p>
      ) : (
        <div className="min-h-0 overflow-auto rounded-2xl border border-border-color bg-secondary-bg">
          <table className="min-w-full text-sm" aria-label="Risks">
            <thead>
              <tr className="border-b border-border-color text-left text-secondary-text">
                {COLUMNS.map(([key, label]) => (
                  <th key={label} scope="col" className="px-3 py-2 font-medium" aria-sort={key && sort === key ? (order === "asc" ? "ascending" : "descending") : undefined}>
                    {key ? (
                      <button type="button" onClick={() => sortBy(key)} className="hover:text-primary-text">
                        {label}
                        {sort === key ? (order === "asc" ? " ▲" : " ▼") : ""}
                      </button>
                    ) : (
                      label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {risks.data.data.map((r) => (
                <tr key={r.id} className="border-b border-border-color last:border-0 hover:bg-primary-text/5">
                  <td className="whitespace-nowrap px-3 py-2">
                    <Link to={riskPath(r.id)} className="font-medium text-primary-text hover:underline">
                      {r.reference}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-primary-text">{r.title}</td>
                  <td className="px-3 py-2 text-secondary-text">{kindLabel(r.kind)}</td>
                  <td className="px-3 py-2 text-secondary-text">{r.category.label}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {r.inherent ? (
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${BAND_PILL[r.inherent.band]}`}>
                        {r.inherent.score} · {bandLabel(r.inherent.band)}
                      </span>
                    ) : (
                      <span className="text-secondary-text">Not assessed</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {r.residual ? (
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${BAND_PILL[r.residual.band]}`}>
                        {r.residual.score} · {bandLabel(r.residual.band)}
                      </span>
                    ) : (
                      <span className="text-secondary-text">—</span>
                    )}
                  </td>
                  <td className={`whitespace-nowrap px-3 py-2 ${r.reviewOverdue ? "font-medium text-error-color" : "text-secondary-text"}`}>
                    {r.nextReviewOn ? `${formatDay(r.nextReviewOn)}${r.reviewOverdue ? " · overdue" : ""}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-secondary-text">{r.owner?.name ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(r.status)}`}>{statusLabel(r.status)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {risks.data && (
        <div className="flex items-center justify-between text-sm text-secondary-text">
          <span>
            {risks.data.total} {risks.data.total === 1 ? "entry" : "entries"}
          </span>
          <div className="flex gap-2">
            <CTAButton type="neutral" disabled={page <= 1} onClick={() => f.updateFilters({ page: String(page - 1) })}>
              Previous
            </CTAButton>
            <CTAButton type="neutral" disabled={page * risks.data.pageSize >= risks.data.total} onClick={() => f.updateFilters({ page: String(page + 1) })}>
              Next
            </CTAButton>
          </div>
        </div>
      )}

      {creating && <RiskDialog onClose={() => setCreating(false)} onSaved={(r) => r?.id && navigate(riskPath(r.id))} />}
    </div>
  );
};

export default RiskRegisterPage;
