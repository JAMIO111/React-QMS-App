import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PlusIcon } from "@/components/icons";
import { useImportManaged } from "../../hooks/useImportManaged";
import { usePermissions } from "../../hooks/useQmsApi";
import { useShipments } from "../../hooks/useShipping";
import { SHIPMENT_FILTERS } from "../../lib/shipping";
import CTAButton from "../CTAButton";
import ImportManagedNotice from "../integrations/ImportManagedNotice";
import Callout from "../ui/Callout";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice, SearchBox } from "../master-data/shared";
import { RecordShipmentDialog } from "./ShippingDialogs";
import { ShipmentsList } from "./ShippingLists";

const PAGE_SIZE = 25;

/** What left, newest first. Search finds a shipment by its number, the delivery note, the order, a lot, a part or the customer. */
const ShipmentsPage = () => {
  const { can } = usePermissions();
  const { managed } = useImportManaged();
  const owner = managed("shipments");
  const [params, setParams] = useSearchParams();
  const status = SHIPMENT_FILTERS.some((f) => f.value === params.get("status")) ? params.get("status") : "shipped";
  const q = params.get("q") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [recording, setRecording] = useState(false);
  const query = useShipments({ status, q: q || undefined, page, pageSize: PAGE_SIZE });
  const set = useCallback((changes) => setParams((p) => { const n = new URLSearchParams(p); Object.entries(changes).forEach(([k, v]) => (v ? n.set(k, v) : n.delete(k))); return n; }), [setParams]);
  const onSearch = useCallback((v) => set({ q: v, page: "" }), [set]);
  const rows = query.data?.data ?? [];
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">Shipments</h1>
          <p className="text-sm text-secondary-text">Deliveries to customers. A line may name the lot it came from, so a customer problem can be traced back to it.</p>
        </div>
        {can("shipping.record") && !owner && <CTAButton type="main" size="default" icon={PlusIcon} onClick={() => setRecording(true)}>Record a shipment</CTAButton>}
      </div>
      <ImportManagedNotice area="shipments" connection={owner} />
      <div className="flex flex-wrap items-center gap-3">
        <SlidingToggle ariaLabel="Which shipments" options={SHIPMENT_FILTERS} value={status} onChange={(v) => set({ status: v === "shipped" ? "" : v, page: "" })} />
        <SearchBox label="Search shipments" onSearch={onSearch} />
      </div>
      {query.error && <ErrorNotice error={query.error} />}
      {query.isLoading ? <p className="text-sm text-secondary-text">Loading…</p> : rows.length === 0 ? (
        <Callout tone="info" title="No shipments here">{q ? "No shipment matches that search." : "Nothing matches this view."}</Callout>
      ) : (
        <MenuCard title={`${total} ${total === 1 ? "shipment" : "shipments"}`} subtitle="Newest first.">
          <ShipmentsList rows={rows} />
          {pages > 1 && (
            <div className="mt-3 flex items-center justify-end gap-3 text-sm text-secondary-text">
              <button type="button" className="hover:underline disabled:opacity-40" disabled={page <= 1} onClick={() => set({ page: page <= 2 ? "" : String(page - 1) })}>Previous</button>
              <span>Page {page} of {pages}</span>
              <button type="button" className="hover:underline disabled:opacity-40" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>Next</button>
            </div>
          )}
        </MenuCard>
      )}
      {recording && <RecordShipmentDialog onClose={() => setRecording(false)} />}
    </div>
  );
};

export default ShipmentsPage;
