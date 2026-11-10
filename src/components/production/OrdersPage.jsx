import { useNavigate } from "react-router-dom";
import { usePermissions } from "../../hooks/useQmsApi";
import { useProductionOrders } from "../../hooks/useProduction";
import { ORDER_STATUS, statusOptions, partLabel } from "../../lib/production";
import { formatDate } from "../../lib/ncr";
import OrderDialog from "./OrderDialog";
import RegisterPage from "./RegisterPage";
import { ORDER_HIDDEN, orderColumns } from "./columns";


const toCsvRow = (r) => ({
  order: r.orderNumber,
  part_number: r.part.partNumber,
  part_name: r.part.name,
  revision: r.partRevision ? `${r.partRevision.revision}${r.partRevision.version > 1 ? ` v${r.partRevision.version}` : ""}` : "",
  customer: r.customer?.name ?? "",
  site: r.site?.name ?? "",
  quantity: r.quantityPlanned,
  due: r.dueDate ?? "",
  status: ORDER_STATUS[r.status]?.label ?? r.status,
  lots: r.lotCount,
  serial_numbers: r.serialCount,
  created: formatDate(r.createdAt),
});

/** Production orders (/Production/Orders): the work a part is made under. A row opens the order's own page, with its operations. */
const OrdersPage = () => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  return (
    <RegisterPage
      noun="order"
      nounPlural="orders"
      columns={orderColumns}
      entityType="production_order"
      defaultHidden={ORDER_HIDDEN}
      prefsKey="production-order-register"
      defaultSort={{ id: "createdAt", desc: true }}
      useRegister={useProductionOrders}
      statusOptions={statusOptions(ORDER_STATUS)}
      scopes={[{ key: "partId", label: "For one part" }]}
      canManage={can("production.manage")}
      newLabel="New order"
      onOpen={(r) => navigate(`/Production/Orders/${r.id}`)}
      rowLabel={(r) => `${r.orderNumber} (${partLabel(r.part)})`}
      toCsvRow={toCsvRow}
      csvName="production-orders.csv"
      dialog={(editing, close) => <OrderDialog order={editing} onClose={close} onSaved={(o) => navigate(`/Production/Orders/${o.id}`)} />}
    />
  );
};

export default OrdersPage;
