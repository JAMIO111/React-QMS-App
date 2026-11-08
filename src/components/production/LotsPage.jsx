import { usePermissions } from "../../hooks/useQmsApi";
import { useLots } from "../../hooks/useProduction";
import { LOT_ORIGIN, LOT_STATUS, statusOptions, partLabel } from "../../lib/production";
import { formatDate } from "../../lib/ncr";
import LotDialog from "./LotDialog";
import RegisterPage from "./RegisterPage";
import { LOT_HIDDEN, lotColumns } from "./columns";


const toCsvRow = (r) => ({
  lot: r.lotNumber,
  part_number: r.part.partNumber,
  part_name: r.part.name,
  origin: LOT_ORIGIN[r.origin],
  production_order: r.productionOrder?.orderNumber ?? "",
  supplier: r.supplier?.name ?? "",
  quantity: r.quantity ?? "",
  status: LOT_STATUS[r.status]?.label ?? r.status,
  hold_reason: r.statusReason ?? "",
  serial_numbers: r.serialCount,
  received: r.receivedOn ?? "",
  created: formatDate(r.createdAt),
});

/** Lots (/Production/Lots): produced from an order or received from a supplier. A row opens the lot in a pop-up. */
const LotsPage = () => {
  const { can } = usePermissions();
  const canManage = can("production.manage");
  return (
    <RegisterPage
      noun="lot"
      nounPlural="lots"
      columns={lotColumns}
      defaultHidden={LOT_HIDDEN}
      prefsKey="lot-register"
      defaultSort={{ id: "createdAt", desc: true }}
      useRegister={useLots}
      statusOptions={statusOptions(LOT_STATUS)}
      selects={[{ key: "origin", label: "Origin", options: Object.entries(LOT_ORIGIN).map(([value, label]) => ({ value, label })) }]}
      scopes={[
        { key: "productionOrderId", label: "For one production order" },
        { key: "partId", label: "For one part" },
        { key: "supplierId", label: "From one supplier" },
      ]}
      canManage={canManage}
      newLabel="New lot"
      onOpen={(r, setEditing) => setEditing(r)}
      rowLabel={(r) => `${r.lotNumber} (${partLabel(r.part)})`}
      toCsvRow={toCsvRow}
      csvName="lots.csv"
      dialog={(editing, close) => <LotDialog lot={editing} readOnly={!canManage} onClose={close} />}
    />
  );
};

export default LotsPage;
