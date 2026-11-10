import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeftIcon, PencilIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useMasterDataMutation } from "../../hooks/useMasterData";
import { useProductionOrder } from "../../hooks/useProduction";
import { useMachines } from "../../hooks/useProcessControl";
import { usePermissions } from "../../hooks/useQmsApi";
import { formatDate } from "../../lib/ncr";
import { OPERATION_MOVES, OPERATION_STATUS, ORDER_MOVES, ORDER_STATUS, orderEditable, orderOperationsEditable, partLabel } from "../../lib/production";
import { ErrorNotice, FormError, SelectField } from "../master-data/shared";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import OrderDialog from "./OrderDialog";
import { StatusBadge, StatusMoves } from "./shared";
import { tracePath } from "../../lib/production";
import CTAButton from "@/components/CTAButton";

const Fact = ({ label, children }) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <dt className="text-xs font-medium text-secondary-text">{label}</dt>
    <dd className="text-sm text-primary-text">{children || "—"}</dd>
  </div>
);

const AddOperation = ({ orderId }) => {
  const [form, setForm] = useState({ operationCode: "", description: "", machineId: null });
  const machines = useMachines({});
  const mutation = useMasterDataMutation();
  const { showToast } = useToast();
  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      { path: `/production-orders/${orderId}/operations`, method: "POST", body: { operationCode: form.operationCode.trim(), description: form.description.trim() || null, machineId: form.machineId } },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Operation added", message: `${form.operationCode.trim()} added to the order.` });
          setForm({ operationCode: "", description: "", machineId: null });
        },
      }
    );
  };
  return (
    <form onSubmit={submit} noValidate aria-label="Add an operation" className="mt-4 flex flex-col gap-2 border-t border-border-color pt-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label="Operation code" required value={form.operationCode} onChange={(e) => setForm((f) => ({ ...f, operationCode: e.target.value }))} maxLength={40} placeholder="OP-10" />
        <Field label="Description" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} maxLength={200} className="sm:col-span-2" />
        <SelectField label="Machine" value={form.machineId} onChange={(v) => setForm((f) => ({ ...f, machineId: v }))} options={(machines.data?.items ?? []).map((m) => ({ value: m.id, label: `${m.code} · ${m.name}` }))} placeholder="Any machine" />
      </div>
      <FormError error={mutation.error} />
      <div>
        <CTAButton buttonType="submit" type="secondary" size="md" disabled={mutation.isPending || !form.operationCode.trim()} loading={mutation.isPending}>
          {mutation.isPending ? "Adding…" : "Add operation"}
        </CTAButton>
      </div>
    </form>
  );
};

/** One production order (/Production/Orders/:id): its details, status, operations, and the lots and serial numbers made for it. */
const OrderPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const canManage = can("production.manage");
  const query = useProductionOrder(id);
  const [editing, setEditing] = useState(false);
  if (query.isLoading) return <p className="p-6 text-secondary-text">Loading…</p>;
  if (query.error || !query.data) return <div className="p-6"><ErrorNotice error={query.error ?? new Error("Not found")} /></div>;
  const o = query.data;
  const revision = o.partRevision ? `${o.partRevision.revision}${o.partRevision.version > 1 ? ` v${o.partRevision.version}` : ""}` : null;

  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-4 overflow-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Link to="/Production/Orders" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
            <ArrowLeftIcon /> Orders
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold text-primary-text">Order {o.orderNumber}</h1>
            <StatusBadge map={ORDER_STATUS} status={o.status} />
          </div>
          {o.statusReason && <p className="text-sm text-secondary-text">{o.statusReason}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {canManage && <StatusMoves moves={ORDER_MOVES[o.status]} path={`/production-orders/${o.id}`} noun="Order" />}
          <CTAButton to={tracePath("order", o.id)} type="secondary" size="md">
            Everything on this order
          </CTAButton>
          <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setEditing(true)}>
            <PencilIcon className="mr-1 inline" /> {canManage && orderEditable(o) ? "Edit" : "View"}
          </CTAButton>
        </div>
      </div>

      <MenuCard title="Order" subtitle="What is being made, for whom and when">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Fact label="Part">
            <Link className="text-link-color hover:underline" to={`/Parts/${o.part.id}`}>
              {partLabel(o.part)}
            </Link>
          </Fact>
          <Fact label="Revision">{revision}</Fact>
          <Fact label="Customer">{o.customer?.name}</Fact>
          <Fact label="Site">{o.site?.name}</Fact>
          <Fact label="Quantity planned">{o.quantityPlanned.toLocaleString()}</Fact>
          <Fact label="Due">{o.dueDate ? formatDate(o.dueDate) : null}</Fact>
          <Fact label="Created">{formatDate(o.createdAt)}</Fact>
          <Fact label="Imported from">{o.external ? `${o.external.system} (${o.external.id})` : null}</Fact>
        </dl>
        {o.notes && <p className="mt-4 whitespace-pre-wrap text-sm text-primary-text">{o.notes}</p>}
      </MenuCard>

      <MenuCard title="Operations" subtitle="The route, in order. An order cannot be completed while an operation is pending or in progress.">
        {o.operations.length === 0 ? (
          <p className="text-sm text-secondary-text">No operations yet.</p>
        ) : (
          <table className="w-full text-sm" aria-label="Operations">
            <thead>
              <tr className="text-left text-xs text-secondary-text">
                <th className="py-1 pr-3">#</th>
                <th className="py-1 pr-3">Operation</th>
                <th className="py-1 pr-3">Description</th>
                <th className="py-1 pr-3">Machine</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {o.operations.map((op) => (
                <tr key={op.id} className="border-t border-border-color">
                  <td className="py-2 pr-3 tabular-nums text-secondary-text">{op.sequence}</td>
                  <td className="py-2 pr-3 font-medium text-primary-text">{op.operationCode}</td>
                  <td className="py-2 pr-3 text-primary-text">{op.description ?? "—"}</td>
                  <td className="py-2 pr-3 text-primary-text">{op.machine ? `${op.machine.code} · ${op.machine.name}` : "—"}</td>
                  <td className="py-2 pr-3">
                    <StatusBadge map={OPERATION_STATUS} status={op.status} />
                  </td>
                  <td className="py-2 text-right">{canManage && orderOperationsEditable(o) && <StatusMoves moves={OPERATION_MOVES[op.status]} path={`/production-operations/${op.id}`} noun={`Operation ${op.operationCode}`} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canManage && orderOperationsEditable(o) && <AddOperation orderId={o.id} />}
      </MenuCard>

      <MenuCard title="Made for this order" subtitle="Lots and serial numbers that name this order">
        <ul className="flex flex-wrap gap-6 text-sm">
          <li>
            <Link className="text-link-color hover:underline" to={`/Production/Lots?productionOrderId=${o.id}`}>
              {o.lotCount} {o.lotCount === 1 ? "lot" : "lots"}
            </Link>
          </li>
          <li>
            <Link className="text-link-color hover:underline" to={`/Production/Serials?productionOrderId=${o.id}`}>
              {o.serialCount} {o.serialCount === 1 ? "serial number" : "serial numbers"}
            </Link>
          </li>
        </ul>
      </MenuCard>

      {editing && <OrderDialog order={o} readOnly={!canManage} onClose={() => setEditing(false)} />}
    </div>
  );
};

export default OrderPage;
