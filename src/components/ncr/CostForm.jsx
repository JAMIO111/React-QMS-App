import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format } from "date-fns";
import { ArrowRightLeftIcon, CoinsIcon, FileTextIcon, ReceiptIcon, SaveIcon, TagIcon } from "@/components/icons";
import RHFComboBox from "../ui/RHFComboBox";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import TextInput from "../ui/TextInput";
import CTAButton from "../CTAButton";
import { describeApiError } from "../../lib/api-client";
import { COST_TYPES, CURRENCY_OPTIONS, VAT_OPTIONS, costAmounts, currencySymbol, formatMoney } from "../../lib/costs";

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
    amount: number("Enter the amount").pipe(z.number().min(0, "Cannot be negative").lt(1e12)),
    exchangeRate: z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number().positive("Must be more than 0").optional()),
    baseCurrency: z.string(),
  })
  .refine((v) => v.currency === v.baseCurrency || v.exchangeRate, { path: ["exchangeRate"], message: "Enter the exchange rate" });

/** Form values for a cost (new: organisation defaults). */
const initialValues = (cost, { baseCurrency, vatRate }) =>
  cost
    ? {
        costType: cost.costType,
        description: cost.description ?? "",
        incurredOn: cost.incurredOn,
        currency: cost.currency,
        vatTreatment: cost.vatTreatment,
        vatRatePercent: cost.vatTreatment === "none" ? round(vatRate * 100) : round(cost.vatRate * 100),
        amount: cost.amount,
        exchangeRate: cost.currency === baseCurrency ? "" : cost.exchangeRate,
        baseCurrency,
      }
    : {
        costType: null,
        description: "",
        incurredOn: format(new Date(), "yyyy-MM-dd"),
        currency: baseCurrency,
        vatTreatment: "none",
        vatRatePercent: round(vatRate * 100),
        amount: "",
        exchangeRate: "",
        baseCurrency,
      };
const round = (n) => Math.round(n * 10000) / 10000;

/**
 * Add or edit a cost line (ported from the original CostInputForm): cost type, VAT option and
 * rate, currency (with exchange rate to the organisation's base currency) and amount, with a live
 * net / VAT / gross preview. The server works out the stored totals the same way.
 */
const CostForm = ({ cost, baseCurrency = "GBP", vatRate = 0.2, onSubmit, onCancel, pending, error }) => {
  const { control, handleSubmit, watch } = useForm({
    resolver: zodResolver(schema),
    defaultValues: initialValues(cost, { baseCurrency, vatRate }),
  });
  const v = watch();
  const foreign = v.currency && v.currency !== baseCurrency;
  const preview = costAmounts({ ...v, vatRate: Number(v.vatRatePercent) / 100 }, baseCurrency);
  const amountLabel = v.vatTreatment === "inclusive" ? "Amount (inc. VAT)" : v.vatTreatment === "exclusive" ? "Amount (ex. VAT)" : "Amount";

  const submit = handleSubmit((values) =>
    onSubmit({
      costType: values.costType,
      description: values.description?.trim() || null,
      incurredOn: values.incurredOn,
      currency: values.currency,
      vatTreatment: values.vatTreatment,
      vatRate: values.vatTreatment === "none" ? 0 : round(values.vatRatePercent / 100),
      amount: values.amount,
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
        {field("amount", (f) => (
          <TextInput {...f} label={amountLabel} required dataType="number" icon={CoinsIcon} prefix={currencySymbol(v.currency).length <= 2 ? currencySymbol(v.currency) : undefined} placeholder="0.00" value={f.value ?? ""} />
        ))}
        {foreign &&
          field("exchangeRate", (f) => (
            <TextInput {...f} label={`Exchange rate (1 ${v.currency} = ? ${baseCurrency})`} required dataType="number" icon={ArrowRightLeftIcon} placeholder="1.00" value={f.value ?? ""} />
          ))}
        <div className="sm:col-span-2">
          {field("description", (f) => <TextInput {...f} label="Description" icon={FileTextIcon} placeholder="What the cost was for" maxLength={500} value={f.value ?? ""} />)}
        </div>
      </div>

      <dl aria-label="Cost preview" className="grid grid-cols-3 gap-2 rounded-xl border border-border-color bg-secondary-bg p-3 text-sm">
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
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-2 rounded-lg border border-success-btn-border bg-success-btn-bg px-3 py-1 text-primary-text hover:bg-success-btn-bg-hover disabled:opacity-50 cursor-pointer">
          <SaveIcon className="h-4 w-4" /> {pending ? "Saving…" : cost ? "Save cost" : "Add cost"}
        </button>
      </div>
    </form>
  );
};

export default CostForm;
