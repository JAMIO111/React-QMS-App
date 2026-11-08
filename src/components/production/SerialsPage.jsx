import { usePermissions } from "../../hooks/useQmsApi";
import { useSerialNumbers } from "../../hooks/useProduction";
import { SERIAL_STATUS, statusOptions, partLabel } from "../../lib/production";
import { formatDate } from "../../lib/ncr";
import RegisterPage from "./RegisterPage";
import SerialDialog from "./SerialDialog";
import { SERIAL_HIDDEN, serialColumns } from "./columns";


const toCsvRow = (r) => ({
  serial_number: r.serialNumber,
  part_number: r.part.partNumber,
  part_name: r.part.name,
  lot: r.lot?.lotNumber ?? "",
  production_order: r.productionOrder?.orderNumber ?? "",
  status: SERIAL_STATUS[r.status]?.label ?? r.status,
  reason: r.statusReason ?? "",
  created: formatDate(r.createdAt),
});

/** Serial numbers (/Production/Serials): one per item, for one part, optionally in a lot and under an order. */
const SerialsPage = () => {
  const { can } = usePermissions();
  const canManage = can("production.manage");
  return (
    <RegisterPage
      noun="serial number"
      nounPlural="serial numbers"
      columns={serialColumns}
      defaultHidden={SERIAL_HIDDEN}
      prefsKey="serial-register"
      defaultSort={{ id: "createdAt", desc: true }}
      useRegister={useSerialNumbers}
      statusOptions={statusOptions(SERIAL_STATUS)}
      scopes={[
        { key: "lotId", label: "In one lot" },
        { key: "productionOrderId", label: "For one production order" },
        { key: "partId", label: "For one part" },
      ]}
      canManage={canManage}
      newLabel="New serial numbers"
      onOpen={(r, setEditing) => setEditing(r)}
      rowLabel={(r) => `${r.serialNumber} (${partLabel(r.part)})`}
      toCsvRow={toCsvRow}
      csvName="serial-numbers.csv"
      dialog={(editing, close) => <SerialDialog serial={editing} readOnly={!canManage} onClose={close} />}
    />
  );
};

export default SerialsPage;
