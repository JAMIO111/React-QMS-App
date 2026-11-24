import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { GitPullRequestArrowIcon, PlusIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { usePermissions } from "../../hooks/useQmsApi";
import { useChanges, useChangeTypes } from "../../hooks/useChange";
import { useUrlFilters } from "../../hooks/useUrlFilters";
import { changePath, formatDay, ORIGIN_KINDS, originLabel, STAGE_OPTIONS, stageLabel, stagePill, urgencyLabel } from "../../lib/change";
import { ErrorNotice, SearchBox } from "../master-data/shared";
import ComboField from "../ui/ComboField";
import LoadingScreen from "../ui/LoadingScreen";
import SlidingToggle from "../ui/SlidingToggle";
import { ChangeDialog } from "./ChangeDialogs";

const CHANGE_FILTER_KEYS = ["search", "stage", "type", "urgency", "origin", "owner", "signer", "sort", "order", "page"];

const COLUMNS = [
  ["reference", "Change"],
  ["title", "Title"],
  ["type", "Type"],
  ["urgency", "Urgency"],
  [null, "Raised from"],
  ["raisedBy", "Raised by"],
  ["createdAt", "Raised"],
  ["stage", "Stage"],
];

/** The change register (`/Change`): every engineering or process change, where it stands and who raised it. Finished ones are left out unless asked for. */
const ChangeRegisterPage = () => {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const f = useUrlFilters(CHANGE_FILTER_KEYS);
  const [creating, setCreating] = useState(false);
  const types = useChangeTypes({ all: true });
  const page = Number(f.page) || 1;
  const sort = f.sort || "reference";
  const order = f.order || "desc";
  const changes = useChanges({ q: f.search, stage: f.stage, typeId: f.type, urgency: f.urgency, originKind: f.origin, owner: f.owner, signer: f.signer, sort, order, page: f.page || undefined });
  const typeOptions = (types.data?.data ?? []).map((t) => ({ value: t.id, label: t.label, hint: t.active ? undefined : "Switched off" }));
  const filtered = f.search || f.stage || f.type || f.urgency || f.origin || f.owner || f.signer;
  const sortBy = (key) => f.updateFilters({ sort: key, order: sort === key && order === "desc" ? "asc" : "desc", page: "" });

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <GitPullRequestArrowIcon className="h-6 w-6" aria-hidden="true" />
            Changes
          </h1>
          <p className="text-sm text-secondary-text">Every change to a part, process, tool, document or supplier, from the request to the check that it worked.</p>
        </div>
        {can("change.manage") && (
          <CTAButton buttonType="button" type="main" icon={PlusIcon} onClick={() => setCreating(true)}>
            Raise a change
          </CTAButton>
        )}
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <SearchBox label="Search changes" onSearch={(v) => f.updateFilters({ search: v, page: "" })} />
        <div className="w-52">
          <ComboField label="Type" value={f.type || null} onChange={(v) => f.updateFilters({ type: v ?? "", page: "" })} options={typeOptions} placeholder="Every type" clearable />
        </div>
        <div className="w-52">
          <ComboField
            label="Raised from"
            value={f.origin || null}
            onChange={(v) => f.updateFilters({ origin: v ?? "", page: "" })}
            options={Object.entries(ORIGIN_KINDS).map(([value, label]) => ({ value, label }))}
            placeholder="Anywhere"
            clearable
          />
        </div>
        <SlidingToggle ariaLabel="Urgency" options={[{ value: "", label: "Any urgency" }, { value: "expedited", label: "Expedited" }]} value={f.urgency || ""} onChange={(v) => f.updateFilters({ urgency: v, page: "" })} />
        <SlidingToggle ariaLabel="Raised by" options={[{ value: "", label: "Everyone's" }, { value: "me", label: "Mine" }]} value={f.owner || ""} onChange={(v) => f.updateFilters({ owner: v, page: "" })} />
        <SlidingToggle ariaLabel="Sign-off" options={[{ value: "", label: "Any sign-off" }, { value: "me", label: "Waiting for me" }]} value={f.signer || ""} onChange={(v) => f.updateFilters({ signer: v, page: "" })} />
      </div>
      <SlidingToggle ariaLabel="Stage" options={STAGE_OPTIONS} value={f.stage || ""} onChange={(v) => f.updateFilters({ stage: v, page: "" })} />

      {changes.isLoading ? (
        <LoadingScreen />
      ) : changes.error ? (
        <ErrorNotice error={changes.error} />
      ) : changes.data.data.length === 0 ? (
        <p className="text-sm text-secondary-text">{filtered ? "No changes match." : "No changes yet."}</p>
      ) : (
        <div className="min-h-0 overflow-auto rounded-2xl border border-border-color bg-secondary-bg">
          <table className="min-w-full text-sm" aria-label="Changes">
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
              {changes.data.data.map((c) => (
                <tr key={c.id} className="border-b border-border-color last:border-0 hover:bg-primary-text/5">
                  <td className="whitespace-nowrap px-3 py-2">
                    <Link to={changePath(c.id)} className="font-medium text-primary-text hover:underline">
                      {c.reference}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-primary-text">{c.title}</td>
                  <td className="px-3 py-2 text-secondary-text">{c.type.label}</td>
                  <td className={`whitespace-nowrap px-3 py-2 ${c.urgency === "expedited" ? "font-medium text-warning-color" : "text-secondary-text"}`}>{urgencyLabel(c.urgency)}</td>
                  <td className="px-3 py-2 text-secondary-text">{c.originKind ? originLabel(c.originKind) : "—"}</td>
                  <td className="px-3 py-2 text-secondary-text">{c.raisedBy?.name ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-secondary-text">{formatDay(c.createdAt)}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${stagePill(c.stage)}`}>{stageLabel(c.stage)}</span>
                    {c.waitingForMe && <span className="ml-2 inline-flex rounded-full bg-warning-color/15 px-2 py-0.5 text-xs font-medium text-warning-color">Waiting for you</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {changes.data && (
        <div className="flex items-center justify-between text-sm text-secondary-text">
          <span>
            {changes.data.total} {changes.data.total === 1 ? "change" : "changes"}
          </span>
          <div className="flex gap-2">
            <CTAButton type="neutral" disabled={page <= 1} onClick={() => f.updateFilters({ page: String(page - 1) })}>
              Previous
            </CTAButton>
            <CTAButton type="neutral" disabled={page * changes.data.pageSize >= changes.data.total} onClick={() => f.updateFilters({ page: String(page + 1) })}>
              Next
            </CTAButton>
          </div>
        </div>
      )}

      {creating && <ChangeDialog onClose={() => setCreating(false)} onSaved={(c) => c?.id && navigate(changePath(c.id))} />}
    </div>
  );
};

export default ChangeRegisterPage;
