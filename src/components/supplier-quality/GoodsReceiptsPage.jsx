import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PlusIcon } from "@/components/icons";
import { usePermissions } from "../../hooks/useQmsApi";
import { useReceipts } from "../../hooks/useReceiving";
import { RECEIPT_FILTERS } from "../../lib/receiving";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice, SearchBox } from "../master-data/shared";
import { RecordReceiptDialog } from "./ReceivingDialogs";
import { ReceiptsList } from "./ReceivingLists";

const PAGE_SIZE = 25;

/** What arrived, newest first. Search finds a receipt by its number, the delivery note, the order, a lot, a part or the supplier. */
const GoodsReceiptsPage = () => {
  const { can } = usePermissions();
  const [params, setParams] = useSearchParams();
  const status = RECEIPT_FILTERS.some((f) => f.value === params.get("status")) ? params.get("status") : "received";
  const q = params.get("q") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [recording, setRecording] = useState(false);
  const query = useReceipts({ status, q: q || undefined, page, pageSize: PAGE_SIZE });
  const set = useCallback((changes) => setParams((p) => { const n = new URLSearchParams(p); Object.entries(changes).forEach(([k, v]) => (v ? n.set(k, v) : n.delete(k))); return n; }), [setParams]);
  const onSearch = useCallback((v) => set({ q: v, page: "" }), [set]);
  const rows = query.data?.data ?? [];
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">Goods receipts</h1>
          <p className="text-sm text-secondary-text">Deliveries from suppliers. A line with a lot number makes the received lot, so it can be traced and, later, inspected.</p>
        </div>
        {can("receiving.manage") && <CTAButton type="main" size="default" icon={PlusIcon} onClick={() => setRecording(true)}>Record a delivery</CTAButton>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SlidingToggle ariaLabel="Which receipts" options={RECEIPT_FILTERS} value={status} onChange={(v) => set({ status: v === "received" ? "" : v, page: "" })} />
        <SearchBox label="Search receipts" onSearch={onSearch} />
      </div>
      {query.error && <ErrorNotice error={query.error} />}
      {query.isLoading ? <p className="text-sm text-secondary-text">Loading…</p> : rows.length === 0 ? (
        <Callout tone="info" title="No goods receipts here">{q ? "No receipt matches that search." : "Nothing matches this view."}</Callout>
      ) : (
        <MenuCard title={`${total} ${total === 1 ? "receipt" : "receipts"}`} subtitle="Newest first.">
          <ReceiptsList rows={rows} />
          {pages > 1 && (
            <div className="mt-3 flex items-center justify-end gap-3 text-sm text-secondary-text">
              <button type="button" className="hover:underline disabled:opacity-40" disabled={page <= 1} onClick={() => set({ page: page <= 2 ? "" : String(page - 1) })}>Previous</button>
              <span>Page {page} of {pages}</span>
              <button type="button" className="hover:underline disabled:opacity-40" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>Next</button>
            </div>
          )}
        </MenuCard>
      )}
      {recording && <RecordReceiptDialog onClose={() => setRecording(false)} />}
    </div>
  );
};

export default GoodsReceiptsPage;
