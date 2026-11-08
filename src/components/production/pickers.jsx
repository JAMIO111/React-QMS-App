import { partLabel } from "../../lib/production";
import { useOrderLookup, useLotLookup, useSerialLookup } from "../../hooks/useProduction";
import { useDebouncedSearch } from "../../hooks/useDebouncedSearch";
import { RemoteComboBox } from "../ncr/Pickers";

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
