import { useState } from "react";
import { usePermissions } from "../../hooks/useQmsApi";
import { useOrderLookup, useLotLookup, useProductionSettings, useSerialLookup } from "../../hooks/useProduction";
import { canCreateOrder, partLabel } from "../../lib/production";
import { useDebouncedSearch } from "../../hooks/useDebouncedSearch";
import { RemoteComboBox } from "../ncr/Pickers";
import InlineOrderDialog from "./InlineOrderDialog";

/**
 * Server-searched pickers over open production records. `current` is the saved record ({ id, orderNumber | lotNumber | serialNumber }) so its name shows even when the search does
 * not list it. `onChange(id, item)`: `item` carries the part and (for lots and serial numbers) the order, which callers use to fill in what the choice implies.
 */
const orderOption = (o) => ({ id: o.id, name: o.orderNumber, hint: `${partLabel(o.part)} · ${o.status.replace(/_/g, " ")}`, part: o.part, status: o.status });
export const OrderPicker = ({ partId, current, label = "Production order", ...props }) => {
  const [q, setSearch] = useDebouncedSearch();
  const orders = useOrderLookup({ q, partId });
  return (
    <RemoteComboBox
      {...props}
      label={label}
      placeholder="Search order number…"
      items={(orders.data ?? []).map(orderOption)}
      isFetching={orders.isFetching}
      onSearch={setSearch}
      current={current ? { id: current.id, name: current.orderNumber } : undefined}
    />
  );
};

const lotOption = (l) => ({
  id: l.id,
  name: l.lotNumber,
  hint: `${partLabel(l.part)}${l.productionOrder ? ` · ${l.productionOrder.orderNumber}` : ""}${l.status === "on_hold" ? " · ON HOLD" : ""}`,
  part: l.part,
  productionOrder: l.productionOrder,
  status: l.status,
});
export const LotPicker = ({ partId, productionOrderId, current, label = "Lot", ...props }) => {
  const [q, setSearch] = useDebouncedSearch();
  const lots = useLotLookup({ q, partId, productionOrderId });
  return (
    <RemoteComboBox
      {...props}
      label={label}
      placeholder="Search lot number…"
      items={(lots.data ?? []).map(lotOption)}
      isFetching={lots.isFetching}
      onSearch={setSearch}
      current={current ? { id: current.id, name: current.lotNumber } : undefined}
    />
  );
};

const serialOption = (s) => ({ id: s.id, name: s.serialNumber, hint: `${partLabel(s.part)}${s.lot ? ` · ${s.lot.lotNumber}` : ""}`, part: s.part, lot: s.lot, productionOrder: s.productionOrder, status: s.status });
export const SerialPicker = ({ partId, lotId, current, label = "Serial number", ...props }) => {
  const [q, setSearch] = useDebouncedSearch();
  const serials = useSerialLookup({ q, partId, lotId });
  return (
    <RemoteComboBox
      {...props}
      label={label}
      placeholder="Search serial number…"
      items={(serials.data ?? []).map(serialOption)}
      isFetching={serials.isFetching}
      onSearch={setSearch}
      current={current ? { id: current.id, name: current.serialNumber } : undefined}
    />
  );
};

/**
 * The order picker with "make a new order" beside it, for people who may (production.manage, or inspection.record when the organisation allows it). Needs the part, because an order is for one
 * part. The new order is chosen at once: `onChange(id, order)`, with `order` the whole record.
 */
export const OrderPickerWithCreate = ({ part, siteId, value, current, onChange, label, required, disabled }) => {
  const { can } = usePermissions();
  const settings = useProductionSettings();
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState(null);
  const shown = made && made.id === value ? made : current;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <OrderPicker partId={part?.id} value={value} current={shown} label={label} required={required} disabled={disabled} onChange={onChange} />
      {!disabled && part && canCreateOrder(can, settings) && (
        <button type="button" onClick={() => setMaking(true)} className="w-fit text-sm text-link-color hover:underline cursor-pointer">
          Not listed? Make a new order
        </button>
      )}
      {making && (
        <InlineOrderDialog
          part={part}
          siteId={siteId}
          onClose={() => setMaking(false)}
          onCreated={(order) => {
            setMade(order);
            onChange(order.id, { id: order.id, name: order.orderNumber, part: order.part, status: order.status });
          }}
        />
      )}
    </div>
  );
};
