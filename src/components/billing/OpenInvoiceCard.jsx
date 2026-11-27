import { owedWords } from "../../lib/billing";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";

const open = (url) => window.open(url, "_blank", "noopener,noreferrer");

/**
 * What is owed on an invoiced subscription (docs/invoice-billing-plan.md §4.5): the oldest open invoice with a way to pay it (Stripe's page: bank details or card)
 * and to download it, and what is held back until the first one is paid. Nothing for a card subscription.
 */
const OpenInvoiceCard = ({ sub }) => {
  if (!sub || sub.paymentRoute !== "invoice") return null;
  const invoice = sub.openInvoice;
  const owed = invoice ? owedWords(invoice, sub.currency) : "";
  if (!invoice) {
    return <Callout tone="success">No invoice is waiting to be paid. Invoices are payable within {sub.paymentTermsDays ?? 14} days of being issued.</Callout>;
  }
  const late = invoice.overdueDays > 0;
  return (
    <Callout
      tone={late ? "error" : "info"}
      role={late ? "alert" : "status"}
      title={sub.firstInvoicePending ? "Your first invoice is waiting to be paid" : late ? "An invoice is overdue" : "An invoice is waiting to be paid"}
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {invoice.hostedUrl && (
            <CTAButton buttonType="button" type="main" size="md" onClick={() => open(invoice.hostedUrl)}>
              Pay this invoice
            </CTAButton>
          )}
          {invoice.pdfUrl && (
            <CTAButton buttonType="button" type="neutral" size="md" onClick={() => open(invoice.pdfUrl)}>
              Download
            </CTAButton>
          )}
        </div>
      }>
      <p>
        {owed}.{late ? " Access stops if it stays unpaid." : ""}
      </p>
      {sub.firstInvoicePending && <p className="text-secondary-text">Seats can be added and reporting keys made once it is paid.</p>}
    </Callout>
  );
};

export default OpenInvoiceCard;
