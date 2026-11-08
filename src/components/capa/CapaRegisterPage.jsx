import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PlusIcon } from "@/components/icons";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import RHFComboBox from "../ui/RHFComboBox";
import { usePermissions } from "../../hooks/useQmsApi";
import { useCapas } from "../../hooks/useCapa";
import { STAGES, capaHref, stepOf } from "../../lib/capa";
import { formatDay } from "../../lib/qualityAlerts";
import { ErrorNotice } from "../master-data/shared";
import { StagePill, StepProgress } from "./shared";
import StartCapaDialog from "./StartCapaDialog";
import CTAButton from "@/components/CTAButton";

const th = "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2 align-top";
const STAGE_OPTIONS = [{ id: "all", name: "All stages" }, ...STAGES.map((s) => ({ id: s.key, name: s.label }))];

/**
 * Corrective actions (8D): the register. Running 8Ds by default; filters live in the URL. Starting an 8D here is for one that is not tied to a
 * non-conformance; from an NC use the Investigation card on the NC page.
 */
const CapaRegisterPage = () => {
  const [params, setParams] = useSearchParams();
  const { can } = usePermissions();
  const manage = can("capa.manage");
  const [starting, setStarting] = useState(false);
  const stage = params.get("stage") ?? "running";
  const filters = { stage, q: params.get("q") ?? "", ...(params.get("owner") === "me" ? { owner: "me" } : {}) };
  const query = useCapas(filters);
  const set = (patch) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
      return next;
    });
  const capas = query.data?.data ?? [];

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">Corrective actions (8D)</h1>
          <p className="text-sm text-secondary-text">Find the root cause, fix it for good and prove it worked. One 8D can address many non-conformances.</p>
        </div>
        {manage && (
          <CTAButton buttonType="button" type="main" size="lg" className="inline-flex items-center gap-1" onClick={() => setStarting(true)}>
            <PlusIcon className="h-4 w-4" /> Start an 8D
          </CTAButton>
        )}
      </div>

      <MenuCard title="Register" subtitle={query.data ? `${capas.length} shown` : undefined}>
        <div className="mb-3 grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search" value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder="Title or CAPA number" maxLength={100} />
          <RHFComboBox label="Stage" value={stage === "running" ? null : stage} onChange={(v) => set({ stage: v ?? "" })} options={STAGE_OPTIONS} sort={false} placeholder="Running (not closed or cancelled)" />
          <label className="flex items-center gap-2 pb-2 text-sm text-primary-text">
            <input type="checkbox" checked={filters.owner === "me"} onChange={(e) => set({ owner: e.target.checked ? "me" : "" })} /> Only 8Ds I own
          </label>
        </div>
        {query.isLoading && <p className="text-secondary-text">Loading 8Ds…</p>}
        {query.error && <ErrorNotice error={query.error} />}
        {query.data && capas.length === 0 && <p className="text-sm text-primary-text">No 8Ds match.</p>}
        {capas.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-separate border-spacing-0 text-sm text-primary-text" aria-label="8Ds">
              <thead>
                <tr>
                  <th scope="col" className={th}>8D</th>
                  <th scope="col" className={th}>Title</th>
                  <th scope="col" className={th}>Stage</th>
                  <th scope="col" className={th}>Progress</th>
                  <th scope="col" className={th}>Owner</th>
                  <th scope="col" className={th}>Due</th>
                  <th scope="col" className={`${th} text-right`}>NCs</th>
                </tr>
              </thead>
              <tbody>
                {capas.map((c) => (
                  <tr key={c.id}>
                    <td className={`${td} whitespace-nowrap`}>
                      <Link to={capaHref(c)} className="font-medium text-link-color hover:underline">{c.reference}</Link>
                    </td>
                    <td className={td}>
                      {c.title}
                      {c.externalReference && <span className="block text-xs text-secondary-text">{c.externalReference}</span>}
                    </td>
                    <td className={td}><StagePill stage={c.stage} /></td>
                    <td className={td} title={stepOf(c.currentStep).title}><StepProgress done={c.stepsDone} current={c.stage === "closed" || c.stage === "cancelled" ? null : c.currentStep} /></td>
                    <td className={td}>{c.owner?.name ?? "—"}</td>
                    <td className={`${td} whitespace-nowrap`}>
                      {formatDay(c.dueDate)}
                      {c.overdue && <span className="ml-1 font-medium text-error-color">· Overdue</span>}
                    </td>
                    <td className={`${td} text-right tabular-nums`}>{c.ncrCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </MenuCard>
      {starting && <StartCapaDialog onClose={() => setStarting(false)} />}
    </div>
  );
};

export default CapaRegisterPage;
