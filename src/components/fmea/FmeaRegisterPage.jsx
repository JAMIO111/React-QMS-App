import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ListTreeIcon, PlusIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { usePermissions } from "../../hooks/useQmsApi";
import { useFmeas } from "../../hooks/useFmea";
import { useUrlFilters } from "../../hooks/useUrlFilters";
import { FMEA_KINDS, fmeaPath, formatDay, kindLabel, STATUS_OPTIONS, statusLabel, statusPill } from "../../lib/fmea";
import { ErrorNotice, SearchBox } from "../master-data/shared";
import LoadingScreen from "../ui/LoadingScreen";
import SlidingToggle from "../ui/SlidingToggle";
import { FmeaDialog } from "./FmeaDialogs";

const FMEA_FILTER_KEYS = ["search", "kind", "status", "owner", "waiting", "overdue", "sort", "order", "page"];

const COLUMNS = [
  ["number", "FMEA"],
  ["title", "Title"],
  ["kind", "Kind"],
  [null, "Covers"],
  ["customer", "Customer"],
  ["owner", "Owner"],
  ["effective", "In force"],
  ["nextReview", "Next review"],
  ["status", "Status"],
];

/** The FMEA register (`/FMEA/Register`): every design and process FMEA, what it covers, who owns it and whether it is in force and due for review. */
const FmeaRegisterPage = () => {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const f = useUrlFilters(FMEA_FILTER_KEYS);
  const [creating, setCreating] = useState(false);
  const page = Number(f.page) || 1;
  const sort = f.sort || "number";
  const order = f.order || "desc";
  const fmeas = useFmeas({
    q: f.search, kind: f.kind, status: f.status, owner: f.owner, waiting: f.waiting, reviewOverdue: f.overdue ? "true" : undefined, sort, order, page: f.page || undefined,
  });
  const filtered = f.search || f.kind || f.status || f.owner || f.waiting || f.overdue;
  const sortBy = (key) => f.updateFilters({ sort: key, order: sort === key && order === "desc" ? "asc" : "desc", page: "" });

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <ListTreeIcon className="h-6 w-6" aria-hidden="true" />
            FMEAs
          </h1>
          <p className="text-sm text-secondary-text">What could fail in a design or a process, how serious it would be, and what is done about it.</p>
        </div>
        {can("fmea.manage") && (
          <CTAButton buttonType="button" type="main" icon={PlusIcon} onClick={() => setCreating(true)}>
            Start an FMEA
          </CTAButton>
        )}
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <SearchBox label="Search FMEAs" onSearch={(v) => f.updateFilters({ search: v, page: "" })} />
        <SlidingToggle ariaLabel="Kind" options={[{ value: "", label: "Any kind" }, ...FMEA_KINDS.map((k) => ({ value: k.value, label: k.label }))]} value={f.kind || ""} onChange={(v) => f.updateFilters({ kind: v, page: "" })} />
        <SlidingToggle ariaLabel="Owner" options={[{ value: "", label: "Everyone's" }, { value: "me", label: "Mine" }]} value={f.owner || ""} onChange={(v) => f.updateFilters({ owner: v, page: "" })} />
        <SlidingToggle ariaLabel="Approval" options={[{ value: "", label: "Any approval" }, { value: "me", label: "Waiting for me" }]} value={f.waiting || ""} onChange={(v) => f.updateFilters({ waiting: v, page: "" })} />
        <SlidingToggle ariaLabel="Review" options={[{ value: "", label: "Any review" }, { value: "true", label: "Review overdue" }]} value={f.overdue || ""} onChange={(v) => f.updateFilters({ overdue: v, page: "" })} />
      </div>
      <SlidingToggle ariaLabel="Status" options={STATUS_OPTIONS} value={f.status || ""} onChange={(v) => f.updateFilters({ status: v, page: "" })} />

      {fmeas.isLoading ? (
        <LoadingScreen />
      ) : fmeas.error ? (
        <ErrorNotice error={fmeas.error} />
      ) : fmeas.data.data.length === 0 ? (
        <p className="text-sm text-secondary-text">{filtered ? "No FMEAs match." : "No FMEAs yet."}</p>
      ) : (
        <div className="min-h-0 overflow-auto rounded-2xl border border-border-color bg-secondary-bg">
          <table className="min-w-full text-sm" aria-label="FMEAs">
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
              {fmeas.data.data.map((m) => (
                <tr key={m.id} className="border-b border-border-color last:border-0 hover:bg-primary-text/5">
                  <td className="whitespace-nowrap px-3 py-2">
                    <Link to={fmeaPath(m.id)} className="font-medium text-primary-text hover:underline">
                      {m.number}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-primary-text">{m.title}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-secondary-text">{kindLabel(m.kind)}</td>
                  <td className="px-3 py-2 text-secondary-text">{m.teamCount ? `${m.teamCount} on the team` : "—"}</td>
                  <td className="px-3 py-2 text-secondary-text">{m.customer?.name ?? "—"}</td>
                  <td className="px-3 py-2 text-secondary-text">{m.owner?.name ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-secondary-text">{m.currentLetter ? `Rev ${m.currentLetter} from ${formatDay(m.currentEffectiveFrom)}` : "—"}</td>
                  <td className={`whitespace-nowrap px-3 py-2 ${m.reviewOverdue ? "font-medium text-error-color" : "text-secondary-text"}`}>
                    {m.nextReviewOn ? `${formatDay(m.nextReviewOn)}${m.reviewOverdue ? " (overdue)" : ""}` : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(m.status)}`}>{statusLabel(m.status)}</span>
                    {m.waitingForMe && <span className="ml-2 inline-flex rounded-full bg-warning-color/15 px-2 py-0.5 text-xs font-medium text-warning-color">Waiting for you</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {fmeas.data && (
        <div className="flex items-center justify-between text-sm text-secondary-text">
          <span>
            {fmeas.data.total} {fmeas.data.total === 1 ? "FMEA" : "FMEAs"}
          </span>
          <div className="flex gap-2">
            <CTAButton type="neutral" disabled={page <= 1} onClick={() => f.updateFilters({ page: String(page - 1) })}>
              Previous
            </CTAButton>
            <CTAButton type="neutral" disabled={page * fmeas.data.pageSize >= fmeas.data.total} onClick={() => f.updateFilters({ page: String(page + 1) })}>
              Next
            </CTAButton>
          </div>
        </div>
      )}

      {creating && <FmeaDialog onClose={() => setCreating(false)} onSaved={(m) => m?.id && navigate(fmeaPath(m.id))} />}
    </div>
  );
};

export default FmeaRegisterPage;
