import Field from "../ui/Field";
import RHFComboBox from "../ui/RHFComboBox";
import { countryOptions } from "../../lib/onboarding";

/**
 * The company an invoice is for (docs/invoice-billing-plan.md §4.5): legal name, where to send it, the billing address, an optional VAT number (UK or EU, checked
 * with Stripe) and an optional purchase order reference that goes on every invoice. `value` is the company object (see EMPTY_COMPANY); `onCheck` is told when the
 * name or the VAT number is left, so the server can say early that this company already has an organisation.
 */
const InvoiceDetailsForm = ({ value, onChange, onCheck, disabled = false, vatError = null }) => {
  const set = (patch) => onChange({ ...value, ...patch });
  const text = (key) => ({ value: value[key], onChange: (e) => set({ [key]: e.target.value }), disabled });
  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium text-primary-text">Who is the invoice for?</legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Legal company name" required maxLength={200} {...text("legalName")} onBlur={onCheck} hint="As it should appear on the invoice, e.g. Acme Fabrication Limited" />
        <Field label="Send invoices to" type="email" required maxLength={254} {...text("billingEmail")} hint="Your accounts payable address is fine" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Address line 1" required maxLength={120} {...text("addressLine1")} />
        <Field label="Address line 2" maxLength={120} {...text("addressLine2")} />
        <Field label="Town or city" required maxLength={80} {...text("city")} />
        <Field label="County, state or region" maxLength={80} {...text("region")} />
        <Field label="Postcode" required maxLength={20} {...text("postcode")} />
        <RHFComboBox label="Country" required value={value.country} onChange={(v) => set({ country: v ?? "" })} options={countryOptions()} placeholder="Choose a country" disabled={disabled} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="VAT number" maxLength={30} {...text("vatNumber")} onBlur={onCheck} error={vatError} hint="Optional. UK and EU numbers are checked with Stripe." />
        <Field label="Purchase order reference" maxLength={100} {...text("poReference")} hint="Optional. Printed on every invoice." />
      </div>
    </fieldset>
  );
};

export default InvoiceDetailsForm;
