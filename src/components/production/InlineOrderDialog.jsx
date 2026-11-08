import { useState } from "react";
import { useToast } from "../../contexts/ToastProvider";
import { useCreateInlineOrder } from "../../hooks/useProduction";
import { partLabel } from "../../lib/production";
import { buttonClass, FormError } from "../master-data/shared";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";

/**
 * Make a production order from a job or non-conformance, for the part it is about: just the number and the quantity (24 on WO-154789). Everything else can be added on the order's own page
 * later. The database decides who may; this form is only offered to people who can.
 */
const InlineOrderDialog = ({ part, siteId, initialNumber = "", onClose, onCreated }) => {
  const mutation = useCreateInlineOrder();
  const { showToast } = useToast();
  const [number, setNumber] = useState(initialNumber);
  const [quantity, setQuantity] = useState("");
  const valid = number.trim().length > 0 && Number(quantity) > 0;

  const submit = (e) => {
    e.preventDefault();
    e.stopPropagation(); // this dialog can sit inside another form (the NC page)
    mutation.mutate(
      { orderNumber: number.trim(), partId: part.id, quantityPlanned: Number(quantity), ...(siteId ? { siteId } : {}) },
      {
        onSuccess: (order) => {
          showToast({ type: "success", title: "Order made", message: `Order ${order.orderNumber} was made for ${partLabel(part)}.` });
          onCreated(order);
          onClose();
        },
      }
    );
  };

  return (
    <Dialog title="Make a production order" onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label="Make a production order">
        <p className="text-sm text-secondary-text">For {partLabel(part)}. Planning can add the rest on the order's page.</p>
        <Field label="Order number" required value={number} onChange={(e) => setNumber(e.target.value)} maxLength={60} placeholder="WO-154789" />
        <Field label="Quantity ordered" required type="number" min="1" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="24" />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.neutral} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={buttonClass.primary} disabled={mutation.isPending || !valid}>
            {mutation.isPending ? "Making…" : "Make order"}
          </button>
        </div>
      </form>
    </Dialog>
  );
};

export default InlineOrderDialog;
