import { useState } from "react";
import { PencilIcon, PlusIcon, Trash2Icon } from "@/components/icons";
import Field from "../ui/Field";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useToast } from "../../contexts/ToastProvider";
import { useMasterDataMutation, useParties } from "../../hooks/useMasterData";
import { describeApiError } from "../../lib/api-client";
import { buttonClass, FormError, SelectField } from "./shared";

const th = "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2";

/** Add a customer to the part, or edit the customer's own part number for it. */
const CustomerLinkForm = ({ part, link, onDone }) => {
  const mutation = useMasterDataMutation();
  const customers = useParties("customers", {});
  const linked = new Set(part.customers.map((c) => c.customer.id));
  const [customerId, setCustomerId] = useState(link?.customer.id ?? null);
  const [customerPartNumber, setCustomerPartNumber] = useState(link?.customerPartNumber ?? "");

  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      link
        ? { path: `/part-customers/${link.id}`, method: "PATCH", body: { customerPartNumber: customerPartNumber.trim() } }
        : { path: `/parts/${part.id}/customers`, body: { customerId, customerPartNumber: customerPartNumber.trim() } },
      { onSuccess: onDone }
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {link ? (
        <p className="text-sm text-primary-text">
          {link.customer.code} · {link.customer.name}
        </p>
      ) : (
        <SelectField
          label="Customer"
          required
          placeholder="Choose a customer"
          value={customerId}
          onChange={setCustomerId}
          options={(customers.data?.items ?? []).filter((c) => !linked.has(c.id)).map((c) => ({ value: c.id, label: `${c.code} · ${c.displayName ?? c.name}` }))}
        />
      )}
      <Field
        label="Customer's part number"
        value={customerPartNumber}
        onChange={(e) => setCustomerPartNumber(e.target.value)}
        maxLength={60}
        hint="Their number for this part, as on their orders and complaints (optional)"
      />
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass.neutral} onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className={buttonClass.primary} disabled={mutation.isPending || (!link && !customerId)}>
          {mutation.isPending ? "Saving…" : link ? "Save" : "Add customer"}
        </button>
      </div>
    </form>
  );
};

/**
 * The customers a part is sold to, each with their own part number; one is primary (shown in lists).
 * The first customer added becomes primary; removing the primary makes another one primary.
 */
const PartCustomers = ({ part, canManage }) => {
  const mutation = useMasterDataMutation();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(null); // null | "new" | link
  const failed = (title) => (err) => showToast({ type: "error", title, message: describeApiError(err) });

  const remove = async (link) => {
    const ok = await confirm({
      title: `Remove ${link.customer.code} from ${part.partNumber}?`,
      message: link.isPrimary && part.customers.length > 1 ? "Another customer becomes the primary one." : "The customer itself is not changed.",
      confirmText: "Remove",
      cancelText: "Cancel",
      type: "warning",
    });
    if (ok) mutation.mutate({ path: `/part-customers/${link.id}`, method: "DELETE" }, { onError: failed("Not removed") });
  };

  return (
    <MenuCard
      title="Customers"
      subtitle="Who this part is sold to, with each customer's own part number."
      bodyClassName="overflow-x-auto"
      action={
        canManage && (
          <button type="button" className={`${buttonClass.neutral} flex items-center gap-1`} onClick={() => setEditing("new")}>
            <PlusIcon className="h-4 w-4" /> Add customer
          </button>
        )
      }>
      {part.customers.length === 0 ? (
        <p className="text-sm text-secondary-text">No customers linked.</p>
      ) : (
        <table className="w-full min-w-[520px] border-separate border-spacing-0 text-sm text-primary-text" aria-label="Customers">
          <thead>
            <tr>
              <th scope="col" className={th}>Customer</th>
              <th scope="col" className={th}>Their part number</th>
              <th scope="col" className={th}><span className="sr-only">Primary customer</span></th>
              {canManage && <th scope="col" className={th}><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {part.customers.map((link) => (
              <tr key={link.id}>
                <td className={td}>
                  <span className="font-medium">{link.customer.code}</span> <span className="text-secondary-text">· {link.customer.name}</span>
                </td>
                <td className={`${td} font-mono`}>{link.customerPartNumber ?? <span className="font-sans text-secondary-text">—</span>}</td>
                <td className={td}>
                  {link.isPrimary ? (
                    <span className="rounded-full bg-brand-primary/15 px-2 py-0.5 text-xs text-primary-text">Primary</span>
                  ) : (
                    canManage && (
                      <button
                        type="button"
                        className="text-xs text-link-color hover:underline cursor-pointer"
                        onClick={() => mutation.mutate({ path: `/part-customers/${link.id}`, method: "PATCH", body: { isPrimary: true } }, { onError: failed("Not changed") })}>
                        Make primary
                      </button>
                    )
                  )}
                </td>
                {canManage && (
                  <td className={td}>
                    <div className="flex justify-end gap-2">
                      <button type="button" className={buttonClass.neutral} onClick={() => setEditing(link)} aria-label={`Edit ${link.customer.code}`}>
                        <PencilIcon className="h-4 w-4" />
                      </button>
                      <button type="button" className={buttonClass.danger} onClick={() => remove(link)} aria-label={`Remove ${link.customer.code}`}>
                        <Trash2Icon className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <Dialog title={editing === "new" ? `Add a customer to ${part.partNumber}` : `Edit ${editing.customer.code}`} onClose={() => setEditing(null)}>
          <CustomerLinkForm part={part} link={editing === "new" ? null : editing} onDone={() => setEditing(null)} />
        </Dialog>
      )}
    </MenuCard>
  );
};

export default PartCustomers;
