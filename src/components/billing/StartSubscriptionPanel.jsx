import { useEffect, useRef, useState } from "react";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useToast } from "../../contexts/ToastProvider";
import { useOrganisationDetails } from "../../hooks/useQmsApi";
import { useCheckInvoiceCompany, useStartCheckout, useStartInvoiceSubscription } from "../../hooks/useSubscription";
import { describeApiError } from "../../lib/api-client";
import { EMPTY_COMPANY, companyProblems, invoiceBody, invoiceStartWords, loadRoute, money, newClientKey, observerProblem, recurringTotal, saveRoute } from "../../lib/billing";
import { FormError } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";
import SlidingToggle from "../ui/SlidingToggle";
import InvoiceDetailsForm from "./InvoiceDetailsForm";
import SeatPicker from "./SeatPicker";

const ROUTES = [
  { value: "card", label: "Pay by card" },
  { value: "invoice", label: "Pay by invoice" },
];

/**
 * Choose seats, then how to pay (docs/invoice-billing-plan.md §4.5). By card goes to Stripe's secure checkout with the free trial; by invoice asks who the invoice is for
 * and starts the subscription at once (no trial: the first invoice is emailed, payable within 14 days). The wizard's plan step and Settings → Subscription both use this.
 * `choice` / `onChoice` are the seats and interval, kept by the caller; `returnTo` is where Stripe sends the person back to.
 */
const StartSubscriptionPanel = ({ plans, choice, onChoice, returnTo = "setup" }) => {
  const { organisationId } = useOrganisation();
  const { showToast } = useToast();
  const { data: org } = useOrganisationDetails();
  const [route, setRoute] = useState(() => loadRoute(organisationId));
  const [company, setCompany] = useState(EMPTY_COMPANY);
  const [touched, setTouched] = useState(false);
  const [problems, setProblems] = useState([]);
  const key = useRef(newClientKey());
  const card = useStartCheckout();
  const invoice = useStartInvoiceSubscription();
  const check = useCheckInvoiceCompany();

  // The organisation's own legal name and country are the likely answers; never overwrite what was typed.
  const orgLegalName = org?.legalName ?? "";
  const orgCountry = org?.country ?? "";
  useEffect(() => {
    if (touched || (!orgLegalName && !orgCountry)) return;
    setCompany((c) => (c.legalName === (c.legalName || orgLegalName) && c.country === (orgCountry || c.country) ? c : { ...c, legalName: c.legalName || orgLegalName, country: orgCountry || c.country }));
  }, [orgLegalName, orgCountry, touched]);

  const pick = (next) => {
    setRoute(next);
    saveRoute(organisationId, next);
  };
  const edit = (next) => {
    setTouched(true);
    setCompany(next);
  };
  const seats = Object.fromEntries(Object.entries(choice.seats).filter(([, q]) => q > 0));
  const busy = card.isPending || invoice.isPending;

  const checkCompany = () => {
    if (company.legalName.trim().length < 2) return;
    check.mutate({ legalName: company.legalName.trim(), vatNumber: company.vatNumber.trim() }, { onSuccess: (r) => setProblems(r.problems), onError: () => setProblems([]) });
  };
  const goCard = () =>
    card.mutate({ interval: choice.interval, seats, returnTo }, { onSuccess: ({ url }) => window.location.assign(url) });
  const goInvoice = () =>
    invoice.mutate(invoiceBody({ choice, company, clientKey: key.current }), {
      onSuccess: () => showToast({ type: "success", title: "Your subscription is active", message: "The first invoice is on its way to the address you gave." }),
    });

  const stillNeeded = [...companyProblems(company), ...problems];
  const vatError = invoice.error?.code === "vat_number_invalid" ? describeApiError(invoice.error) : null;

  return (
    <div className="flex flex-col gap-4">
      <SeatPicker plans={plans} value={choice} onChange={onChoice} disabled={busy} trial={route === "card"} />
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-primary-text">How would you like to pay?</span>
        <SlidingToggle ariaLabel="How to pay" mode="radio" options={ROUTES} value={route} onChange={pick} />
        <p className="text-sm text-secondary-text">
          {route === "card"
            ? "14-day free trial, card required, cancel any time before it ends."
            : "No free trial. We email an invoice, payable within 14 days by bank transfer or card. Your seats are available at once."}
        </p>
      </div>

      {route === "card" ? (
        <>
          <FormError error={card.error} />
          <div className="flex justify-end">
            <CTAButton buttonType="button" type="main" size="lg" disabled={busy || !!observerProblem(choice.seats)} loading={card.isPending} onClick={goCard}>
              {card.isPending ? "Opening checkout…" : "Continue to secure checkout"}
            </CTAButton>
          </div>
        </>
      ) : (
        <>
          <InvoiceDetailsForm value={company} onChange={edit} onCheck={checkCompany} disabled={busy} vatError={vatError} />
          {problems.length > 0 && (
            <Callout tone="warning" title="This company cannot be invoiced from here">
              {problems.join(" ")}
            </Callout>
          )}
          <Callout tone="info">{invoiceStartWords({ total: recurringTotal(plans, choice), interval: choice.interval, email: company.billingEmail })}</Callout>
          {stillNeeded.length > 0 && touched && (
            <p role="status" className="text-sm text-secondary-text">
              Still needed: {stillNeeded[0]}
            </p>
          )}
          <FormError error={vatError ? null : invoice.error} />
          <div className="flex items-center justify-end gap-3">
            <span className="text-sm text-secondary-text">{money(recurringTotal(plans, choice))} per {choice.interval === "year" ? "year" : "month"}, excluding VAT</span>
            <CTAButton buttonType="button" type="main" size="lg" disabled={busy || stillNeeded.length > 0 || !!observerProblem(choice.seats)} loading={invoice.isPending} loadingText="Starting…" onClick={goInvoice}>
              Start subscription
            </CTAButton>
          </div>
        </>
      )}
    </div>
  );
};

export default StartSubscriptionPanel;
