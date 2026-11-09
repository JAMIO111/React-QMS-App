import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PlusIcon } from "@/components/icons";
import { usePermissions } from "../../hooks/useQmsApi";
import { useScars } from "../../hooks/useSupplierQuality";
import { SCAR_FILTERS, scarFilterQuery } from "../../lib/supplierScars";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice, SearchBox } from "../master-data/shared";
import { CreateScarDialog } from "./ScarDialogs";
import ScarsList from "./ScarsList";

const PAGE_SIZE = 25;

/** Supplier corrective action requests across all suppliers. Running is the default; Overdue is those whose response is late. */
const ScarsPage = () => {
  const { can } = usePermissions();
  const [params, setParams] = useSearchParams();
  const filter = SCAR_FILTERS.some((f) => f.value === params.get("filter")) ? params.get("filter") : "running";
  const q = params.get("q") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [creating, setCreating] = useState(false);
  const query = useScars({ ...scarFilterQuery(filter), q: q || undefined, page, pageSize: PAGE_SIZE, sort: "createdAt", order: "desc" });
  const set = useCallback((changes) => setParams((p) => { const n = new URLSearchParams(p); Object.entries(changes).forEach(([k, v]) => (v ? n.set(k, v) : n.delete(k))); return n; }), [setParams]);
  const onSearch = useCallback((v) => set({ q: v, page: "" }), [set]);
  const rows = query.data?.data ?? [];
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">Supplier corrective actions</h1>
          <p className="text-sm text-secondary-text">Requests for a supplier to investigate and fix a problem. A response is reviewed, the fix implemented and its effectiveness checked before a request closes.</p>
        </div>
        {can("supplier_quality.manage") && (
          <CTAButton type="main" size="default" icon={PlusIcon} onClick={() => setCreating(true)}>Raise a SCAR</CTAButton>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SlidingToggle ariaLabel="Which SCARs" options={SCAR_FILTERS} value={filter} onChange={(v) => set({ filter: v === "running" ? "" : v, page: "" })} />
        <SearchBox label="Search SCARs" onSearch={onSearch} />
      </div>
      {query.error && <ErrorNotice error={query.error} />}
      {query.isLoading ? (
        <p className="text-sm text-secondary-text">Loading…</p>
      ) : rows.length === 0 ? (
        <Callout tone={filter === "overdue" ? "success" : "info"} title={filter === "overdue" ? "Nothing is late" : "No SCARs here"}>
          {filter === "overdue" ? "No SCAR is waiting on a response that is past its due date." : q ? "No SCAR matches that search." : "Nothing matches this view."}
        </Callout>
      ) : (
        <MenuCard title={`${total} ${total === 1 ? "SCAR" : "SCARs"}`} subtitle="Newest first.">
          <ScarsList rows={rows} />
          {pages > 1 && (
            <div className="mt-3 flex items-center justify-end gap-3 text-sm text-secondary-text">
              <button type="button" className="hover:underline disabled:opacity-40" disabled={page <= 1} onClick={() => set({ page: page <= 2 ? "" : String(page - 1) })}>Previous</button>
              <span>Page {page} of {pages}</span>
              <button type="button" className="hover:underline disabled:opacity-40" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>Next</button>
            </div>
          )}
        </MenuCard>
      )}
      {creating && <CreateScarDialog onClose={() => setCreating(false)} />}
    </div>
  );
};

export default ScarsPage;
