import { useState } from "react";
import { useInvoiceAccountMutation, usePlatformInvoiceAccounts } from "../../hooks/usePlatform";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import Dialog from "../ui/Dialog";
import Callout from "../ui/Callout";
import CTAButton from "@/components/CTAButton";
import { TextAreaField } from "../master-data/shared";
import { Card, Panel, Pill, Table, Tile, Tiles } from "./Panels";
import { day, pounds, when } from "./format";

/** The two operator switches, each with a reason that is kept in the audit trail. */
const SwitchDialog = ({ account, action, onClose }) => {
  const mutate = useInvoiceAccountMutation();
  const { showToast } = useToast();
  const [reason, setReason] = useState("");
  const billing = action === "billing";
  const next = billing ? !account.billingAllowed : !account.companyExempt;
  const title = billing
    ? next ? `Allow ${account.name} to pay by invoice` : `Stop ${account.name} paying by invoice`
    : next ? `Lift the company block for ${account.name}` : `Restore the company block for ${account.name}`;
  const words = billing
    ? next
      ? "They will be able to choose invoicing again for any new subscription."
      : "A subscription that is already invoiced carries on. They cannot start a new invoiced subscription."
    : next
      ? "Use this for a genuine second legal entity that shares a company name with another invoiced organisation."
      : "Only one invoiced organisation per company will be allowed again.";
  const submit = (e) => {
    e.preventDefault();
    if (reason.trim().length < 3) return;
    onClose();
    mutate.mutate(
      { organisationId: account.organisationId, action, value: next, reason: reason.trim() },
      { onError: (err) => showToast({ type: "error", title: "Not changed", message: describeApiError(err) }) },
    );
  };
  return (
    <Dialog title={title} onClose={onClose} width="max-w-xl">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">{words}</p>
        <TextAreaField label="Why" required value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} hint="Kept in the history of the organisation." />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton type="main" size="md" buttonType="submit" disabled={reason.trim().length < 3}>Confirm</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Organisations that pay by invoice: is the first invoice paid, what is open and how late. Counts and billing only, never quality data. */
const InvoicesPanel = () => {
  const query = usePlatformInvoiceAccounts();
  const [dialog, setDialog] = useState(null);
  return (
    <Panel query={query}>
      {(result) => {
        const rows = result.data ?? [];
        const overdue = rows.filter((a) => a.overdueDays > 0);
        const firstUnpaid = rows.filter((a) => !a.firstInvoicePaid);
        const open = rows.reduce((sum, a) => sum + (a.openAmountPence ?? 0), 0);
        return (
          <div className="flex flex-col gap-4">
            {overdue.length > 0 && (
              <Callout tone="warning" title={`${overdue.length} ${overdue.length === 1 ? "organisation has" : "organisations have"} an overdue invoice`}>
                Access stops once an invoice is past its due date plus the grace period. Chase the oldest first.
              </Callout>
            )}
            <Tiles label="Invoiced organisations">
              <Tile label="Invoiced" value={rows.length} />
              <Tile label="First invoice unpaid" value={firstUnpaid.length} tone={firstUnpaid.length ? "warn" : undefined} />
              <Tile label="Overdue" value={overdue.length} tone={overdue.length ? "bad" : undefined} />
              <Tile label="Open, excluding VAT" value={pounds(open)} />
            </Tiles>
            <Card title="Invoiced organisations" subtitle="Oldest unpaid invoice first. Allowing invoicing and lifting the company block each need a reason.">
              <Table
                caption="Invoiced organisations"
                head={["Organisation", "Company", "First invoice", "Open", "Oldest due", "Started", "Switches"]}
                empty={rows.length === 0 ? "No organisation pays by invoice yet." : null}>
                {rows.map((a) => (
                  <tr key={a.organisationId} className="border-b border-border-color align-top last:border-0">
                    <td className="py-2 pr-3 text-primary-text">
                      <div className="font-medium">{a.name}</div>
                      <div className="text-xs text-secondary-text">{a.subscriptionStatus.replace("_", " ")}, {a.billingInterval === "year" ? "annual" : "monthly"}</div>
                    </td>
                    <td className="py-2 pr-3 text-primary-text">
                      <div>{a.legalName ?? "—"}</div>
                      <div className="text-xs text-secondary-text">{a.billingEmail ?? ""}{a.purchaseOrder ? ` · PO ${a.purchaseOrder}` : ""}</div>
                    </td>
                    <td className="py-2 pr-3"><Pill tone={a.firstInvoicePaid ? "good" : "warn"}>{a.firstInvoicePaid ? "Paid" : "Unpaid"}</Pill></td>
                    <td className="py-2 pr-3 text-primary-text">{a.openInvoices ? `${a.openInvoices} · ${pounds(a.openAmountPence)}` : "None"}</td>
                    <td className="py-2 pr-3 text-primary-text">
                      {a.oldestOpenDueOn ? day(a.oldestOpenDueOn) : "—"}
                      {a.overdueDays > 0 && <div className="text-xs text-error-color">{a.overdueDays} {a.overdueDays === 1 ? "day" : "days"} late</div>}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-primary-text">{when(a.startedAt)}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-2">
                        <CTAButton type="neutral" size="default" onClick={() => setDialog({ account: a, action: "billing" })} aria-label={`${a.billingAllowed ? "Stop" : "Allow"} invoicing for ${a.name}`}>
                          {a.billingAllowed ? "Stop invoicing" : "Allow invoicing"}
                        </CTAButton>
                        <CTAButton type="neutral" size="default" onClick={() => setDialog({ account: a, action: "exempt" })} aria-label={`${a.companyExempt ? "Restore" : "Lift"} the company block for ${a.name}`}>
                          {a.companyExempt ? "Restore company block" : "Lift company block"}
                        </CTAButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </Table>
            </Card>
            {dialog && <SwitchDialog account={dialog.account} action={dialog.action} onClose={() => setDialog(null)} />}
          </div>
        );
      }}
    </Panel>
  );
};

export default InvoicesPanel;
