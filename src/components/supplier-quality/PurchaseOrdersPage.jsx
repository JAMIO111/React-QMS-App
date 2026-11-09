import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PlusIcon } from "@/components/icons";
import { usePermissions } from "../../hooks/useQmsApi";
import { usePurchaseOrders } from "../../hooks/useReceiving";
import { PO_FILTERS, poFilterQuery } from "../../lib/receiving";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice, SearchBox } from "../master-data/shared";
import { CreatePurchaseOrderDialog } from "./ReceivingDialogs";
import { OrdersList } from "./ReceivingLists";

const PAGE_SIZE = 25;

/** What was ordered from suppliers. Open is the default; Late lists orders with a line past its date and not fully received. */
const PurchaseOrdersPage = () => {
  const { can } = usePermissions();
  const [params, setParams] = useSearchParams();
  const filter = PO_FILTERS.some((f) => f.value === params.get("filter")) ? params.get("filter") : "open";
  const q = params.get("q") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [creating, setCreating] = useState(false);
  const query = usePurchaseOrders({ ...poFilterQuery(filter), q: q || undefined, page, pageSize: PAGE_SIZE });
  const set = useCallback((changes) => setParams((p) => { const n = new URLSearchParams(p); Object.entries(changes).forEach(([k, v]) => (v ? n.set(k, v) : n.delete(k))); return n; }), [setParams]);
  const onSearch = useCallback((v) => set({ q: v, page: "" }), [set]);
  const rows = query.data?.data ?? [];
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">Purchase orders</h1>
          <p className="text-sm text-secondary-text">What was ordered from suppliers, the date each line was requested for and the latest date agreed. Deliveries are recorded against them.</p>
        </div>
        {can("receiving.manage") && <CTAButton type="main" size="default" icon={PlusIcon} onClick={() => setCreating(true)}>Record an order</CTAButton>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SlidingToggle ariaLabel="Which orders" options={PO_FILTERS} value={filter} onChange={(v) => set({ filter: v === "open" ? "" : v, page: "" })} />
        <SearchBox label="Search orders" onSearch={onSearch} />
      </div>
      {query.error && <ErrorNotice error={query.error} />}
      {query.isLoading ? <p className="text-sm text-secondary-text">Loading…</p> : rows.length === 0 ? (
        <Callout tone={filter === "late" ? "success" : "info"} title={filter === "late" ? "Nothing is late" : "No purchase orders here"}>
          {filter === "late" ? "No open order has a line past its date that is still waiting for goods." : q ? "No order matches that search." : "Nothing matches this view."}
        </Callout>
      ) : (
        <MenuCard title={`${total} ${total === 1 ? "order" : "orders"}`} subtitle="Newest first.">
          <OrdersList rows={rows} />
          {pages > 1 && (
            <div className="mt-3 flex items-center justify-end gap-3 text-sm text-secondary-text">
              <button type="button" className="hover:underline disabled:opacity-40" disabled={page <= 1} onClick={() => set({ page: page <= 2 ? "" : String(page - 1) })}>Previous</button>
              <span>Page {page} of {pages}</span>
              <button type="button" className="hover:underline disabled:opacity-40" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>Next</button>
            </div>
          )}
        </MenuCard>
      )}
      {creating && <CreatePurchaseOrderDialog onClose={() => setCreating(false)} />}
    </div>
  );
};

export default PurchaseOrdersPage;
