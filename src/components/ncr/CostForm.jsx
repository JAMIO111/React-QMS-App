import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format } from "date-fns";
import { ArrowRightLeftIcon, CoinsIcon, FileTextIcon, HashIcon, ReceiptIcon, SaveIcon, TagIcon } from "@/components/icons";
import RHFComboBox from "../ui/RHFComboBox";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import TextInput from "../ui/TextInput";
import CTAButton from "../CTAButton";
import { describeApiError } from "../../lib/api-client";
import { COST_TYPES, CURRENCY_OPTIONS, VAT_OPTIONS, costAmounts, currencySymbol, formatMoney, formatQuantity, formatUnitMoney } from "../../lib/costs";

const number = (message) =>
  z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number({ required_error: message, invalid_type_error: message }));

const schema = z
  .object({
    costType: z.string({ required_error: "Choose a cost type", invalid_type_error: "Choose a cost type" }),
    description: z.string().max(500).optional(),
    incurredOn: z.string({ invalid_type_error: "Choose a date" }).regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date"),
    currency: z.string({ required_error: "Choose a currency", invalid_type_error: "Choose a currency" }),
    vatTreatment: z.enum(["none", "inclusive", "exclusive"]),
    vatRatePercent: number("Enter the VAT rate").pipe(z.number().min(0, "0–99%").lt(100, "0–99%")),
    quantity: number("Enter the quantity").pipe(z.number().gt(0, "Must be more than 0").lt(1e9, "Too many")),
    unitCost: number("Enter the unit cost").pipe(z.number().min(0, "Cannot be negative").lt(1e12)),
    exchangeRate: z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number().positive("Must be more than 0").optional()),
    baseCurrency: z.string(),
  })
  .refine((v) => v.currency === v.baseCurrency || v.exchangeRate, { path: ["exchangeRate"], message: "Enter the exchange rate" })
  .refine((v) => v.quantity * v.unitCost < 1e12, { path: ["unitCost"], message: "The total is too large" });

/** Form values for a cost (new: organisation defaults). */
const initialValues = (cost, { baseCurrency, defaultCurrency, vatRate }) =>
  cost
    ? {
        costType: cost.costType,
        description: cost.description ?? "",
        incurredOn: cost.incurredOn,
        currency: cost.currency,
        vatTreatment: cost.vatTreatment,
        vatRatePercent: cost.vatTreatment === "none" ? round(vatRate * 100) : round(cost.vatRate * 100),
        quantity: cost.quantity ?? 1,
        unitCost: cost.unitCost ?? cost.amount,
        exchangeRate: cost.currency === baseCurrency ? "" : cost.exchangeRate,
        baseCurrency,
      }
    : {
        costType: null,
        description: "",
        incurredOn: format(new Date(), "yyyy-MM-dd"),
        currency: defaultCurrency || baseCurrency,
        vatTreatment: "none",
        vatRatePercent: round(vatRate * 100),
        quantity: 1,
        unitCost: "",
        exchangeRate: "",
        baseCurrency,
      };
const round = (n) => Math.round(n * 10000) / 10000;

/** Quantity × unit cost, rounded to pennies as the database does; null until both are numbers. */
export const lineAmount = (quantity, unitCost) => {
  if (quantity === "" || quantity === null || quantity === undefined || unitCost === "" || unitCost === null || unitCost === undefined) return null;
  const q = Number(quantity);
  const u = Number(unitCost);
  if (Number.isNaN(q) || Number.isNaN(u)) return null;
  return Math.round(q * u * 100) / 100;
};

/**
 * Add or edit a cost line (ported from the original CostInputForm): cost type, VAT option and
 * rate, currency (starts as `defaultCurrency`, the NC's site currency; exchange rate to the organisation's base currency), quantity and unit cost,
 * with a live amount and net / VAT / gross preview. The server works out the stored amount and totals the same way.
 */
const CostForm = ({ cost, baseCurrency = "GBP", defaultCurrency, vatRate = 0.2, onSubmit, onCancel, pending, error }) => {
  const { control, handleSubmit, watch } = useForm({
    resolver: zodResolver(schema),
    defaultValues: initialValues(cost, { baseCurrency, defaultCurrency, vatRate }),
  });
  const v = watch();
  const foreign = v.currency && v.currency !== baseCurrency;
  const amount = lineAmount(v.quantity, v.unitCost);
  const preview = costAmounts({ ...v, amount, vatRate: Number(v.vatRatePercent) / 100 }, baseCurrency);
  const unitLabel = v.vatTreatment === "inclusive" ? "Unit cost (inc. VAT)" : v.vatTreatment === "exclusive" ? "Unit cost (ex. VAT)" : "Unit cost";
  const symbol = currencySymbol(v.currency).length <= 2 ? currencySymbol(v.currency) : undefined;

  const submit = handleSubmit((values) =>
    onSubmit({
      costType: values.costType,
      description: values.description?.trim() || null,
      incurredOn: values.incurredOn,
      currency: values.currency,
      vatTreatment: values.vatTreatment,
      vatRate: values.vatTreatment === "none" ? 0 : round(values.vatRatePercent / 100),
      quantity: values.quantity,
      unitCost: values.unitCost,
      exchangeRate: values.currency === baseCurrency ? 1 : values.exchangeRate,
    })
  );

  const field = (name, render) => <Controller name={name} control={control} render={({ field: f, fieldState }) => render({ ...f, error: fieldState.error })} />;

  return (
    <form noValidate aria-label={cost ? "Edit cost" : "New cost"} onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {field("costType", (f) => <RHFComboBox {...f} label="Cost type" required icon={TagIcon} placeholder="Select a cost type" options={COST_TYPES} sort={false} />)}
        {field("incurredOn", (f) => <RHFDatePickerPopout {...f} label="Date" required valueFormat="iso" maxDate={new Date()} />)}
        {field("vatTreatment", (f) => <RHFComboBox {...f} label="VAT option" icon={ReceiptIcon} options={VAT_OPTIONS} sort={false} clearable={false} />)}
        {v.vatTreatment !== "none" &&
          field("vatRatePercent", (f) => <TextInput {...f} label="VAT rate" required dataType="number" icon={ReceiptIcon} suffix="%" placeholder="20" value={f.value ?? ""} />)}
        {field("currency", (f) => <RHFComboBox {...f} label="Currency" required icon={CoinsIcon} placeholder="Select a currency" options={CURRENCY_OPTIONS} sort={false} clearable={false} />)}
        {field("quantity", (f) => (
          <TextInput {...f} label="Quantity" required dataType="number" icon={HashIcon} placeholder="1" hint="Pieces, hours, kilograms…" value={f.value ?? ""} />
        ))}
        {field("unitCost", (f) => <TextInput {...f} label={unitLabel} required dataType="number" icon={CoinsIcon} prefix={symbol} placeholder="0.00" value={f.value ?? ""} />)}
        {foreign &&
          field("exchangeRate", (f) => (
            <TextInput {...f} label={`Exchange rate (1 ${v.currency} = ? ${baseCurrency})`} required dataType="number" icon={ArrowRightLeftIcon} placeholder="1.00" value={f.value ?? ""} />
          ))}
        <div className="sm:col-span-2">
          {field("description", (f) => <TextInput {...f} label="Description" icon={FileTextIcon} placeholder="What the cost was for" maxLength={500} value={f.value ?? ""} />)}
        </div>
      </div>

      <dl aria-label="Cost preview" className="grid grid-cols-3 gap-2 rounded-xl border border-border-color bg-secondary-bg p-3 text-sm">
        <div className="col-span-3 flex flex-wrap items-baseline gap-x-2">
          <dt className="text-secondary-text">Amount</dt>
          <dd className="font-semibold text-primary-text">
            {amount !== null ? `${formatQuantity(v.quantity)} × ${formatUnitMoney(v.unitCost, v.currency)} = ${formatMoney(amount, v.currency)}` : "—"}
          </dd>
        </div>
        {[
          ["Net", preview && formatMoney(preview.net, v.currency)],
          ["VAT", preview && formatMoney(preview.vat, v.currency)],
          ["Gross", preview && formatMoney(preview.gross, v.currency)],
        ].map(([k, val]) => (
          <div key={k}>
            <dt className="text-secondary-text">{k}</dt>
            <dd className="font-semibold text-primary-text">{val || "—"}</dd>
          </div>
        ))}
        {foreign && (
          <div className="col-span-3 text-secondary-text">
            In {baseCurrency}: <span className="text-primary-text">{preview && v.exchangeRate ? `${formatMoney(preview.netBase, baseCurrency)} net · ${formatMoney(preview.grossBase, baseCurrency)} gross` : "—"}</span>
          </div>
        )}
      </dl>

      {error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(error)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <CTAButton type="neutral" text="Cancel" callbackFn={onCancel} />
        <CTAButton
          buttonType="submit"
          disabled={pending} loading={pending}
          type="success" size="md" className="flex items-center gap-2 px-3 py-1">
          <SaveIcon className="h-4 w-4" /> {pending ? "Saving…" : cost ? "Save cost" : "Add cost"}
        </CTAButton>
      </div>
    </form>
  );
};

export default CostForm;
