import { useState } from "react";
import { PlusIcon } from "@/components/icons";
import { usePermissions } from "../../hooks/useQmsApi";
import { usePurchaseOrders, useReceipts } from "../../hooks/useReceiving";
import CTAButton from "../CTAButton";
import MenuCard from "../ui/MenuCard";
import { ErrorNotice } from "../master-data/shared";
import { CreatePurchaseOrderDialog, RecordReceiptDialog } from "./ReceivingDialogs";
import { OrdersList, ReceiptsList } from "./ReceivingLists";

/** The supplier's profile, Incoming quality tab: open purchase orders and the latest deliveries, with the actions to record them. */
const SupplierReceiving = ({ supplier }) => {
  const { can } = usePermissions();
  const allowed = can("receiving.read");
  const [dialog, setDialog] = useState(null);
  const orders = usePurchaseOrders({ supplierId: supplier.id, status: "open", pageSize: 25 }, { enabled: allowed });
  const receipts = useReceipts({ supplierId: supplier.id, status: "received", pageSize: 10 }, { enabled: allowed });
  if (!allowed) return <MenuCard title="Incoming quality"><p className="text-sm text-secondary-text">You do not have access to purchasing and receiving.</p></MenuCard>;
  const manage = can("receiving.manage");
  const close = () => setDialog(null);
  return (
    <div className="flex flex-col gap-4">
      <MenuCard title="Open purchase orders" subtitle="What is still expected from this supplier."
        action={manage ? <CTAButton type="secondary" size="default" icon={PlusIcon} onClick={() => setDialog("order")}>Record an order</CTAButton> : null}>
        {orders.error && <ErrorNotice error={orders.error} />}
        {orders.isLoading ? <p className="text-sm text-secondary-text">Loading…</p> : (orders.data?.data ?? []).length === 0 ? <p className="text-sm text-secondary-text">No open purchase orders.</p> : <OrdersList rows={orders.data.data} showSupplier={false} />}
      </MenuCard>
      <MenuCard title="Latest deliveries" subtitle="The ten most recent. A delivery with a lot number makes the received lot."
        action={manage ? <CTAButton type="main" size="default" icon={PlusIcon} onClick={() => setDialog("receipt")}>Record a delivery</CTAButton> : null}>
        {receipts.error && <ErrorNotice error={receipts.error} />}
        {receipts.isLoading ? <p className="text-sm text-secondary-text">Loading…</p> : (receipts.data?.data ?? []).length === 0 ? <p className="text-sm text-secondary-text">No deliveries recorded yet.</p> : <ReceiptsList rows={receipts.data.data} showSupplier={false} />}
      </MenuCard>
      {dialog === "order" && <CreatePurchaseOrderDialog supplier={supplier} onClose={close} />}
      {dialog === "receipt" && <RecordReceiptDialog supplier={supplier} onClose={close} />}
    </div>
  );
};

export default SupplierReceiving;
