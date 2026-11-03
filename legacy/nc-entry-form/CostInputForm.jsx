import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { NCCostSchema } from "../validationSchema";
import RHFComboBox from "./ui/RHFComboBox";
import TextInput from "./ui/TextInput";
import { BiSolidCategoryAlt } from "react-icons/bi";
import { BsCurrencyExchange } from "react-icons/bs";
import { HiOutlineReceiptTax } from "react-icons/hi";
import { RiSave3Fill } from "react-icons/ri";
import { currencyCodesArray } from "@/currencyCodes";
import CTAButton from "./CTAButton";
import CurrencyComboBox from "./ui/CurrencyComboBox";
import { useOrganisation } from "@/contexts/OrganisationProvider";
import { useToast } from "../contexts/ToastProvider";

export default function CostInputForm({ recordId }) {
  const { showToast } = useToast();
  const { organisation } = useOrganisation();
  const vat_rate = organisation?.vat_rate;
  const base_currency = organisation?.base_currency;

  const defaultValues = {
    type: null,
    currency: null,
    vat: false,
    vat_rate: vat_rate * 100,
    cost_amount: undefined,
  };

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    control,
    reset,
    formState: { errors: formErrors, isValid },
  } = useForm({
    resolver: zodResolver(NCCostSchema),
    mode: "all",
    defaultValues: defaultValues,
    delayError: 500,
  });

  const onSubmit = (data, recordId) => {
    const currency = data.currency || base_currency; // fallback if needed
    const { decimal_digits = 2, rounding = 0 } =
      currencyCodesArray[currency] || {};
    const multiplier = Math.pow(10, decimal_digits); // e.g., 100 for 2 decimal places

    const inputAmount = parseFloat(data.cost_amount);
    const vatRateDecimal = parseFloat(data.vat_rate) / 100;

    let cost_net_pennies = 0;
    let cost_gross_pennies = 0;

    // Determine net/gross depending on VAT selection
    if (data.vat === "VAT Inclusive") {
      cost_gross_pennies = Math.round(inputAmount * multiplier);
      cost_net_pennies = Math.round(cost_gross_pennies / (1 + vatRateDecimal));
    } else if (data.vat === "VAT Exclusive") {
      cost_net_pennies = Math.round(inputAmount * multiplier);
      cost_gross_pennies = Math.round(cost_net_pennies * (1 + vatRateDecimal));
    } else {
      // No VAT
      cost_net_pennies = Math.round(inputAmount * multiplier);
      cost_gross_pennies = cost_net_pennies;
    }

    const cost_vat_pennies = cost_gross_pennies - cost_net_pennies;

    const roundValue = (value) => {
      if (rounding === 0) return value;
      return Math.round(value / rounding) * rounding;
    };

    const cost_net = roundValue(cost_net_pennies / multiplier);
    const cost_gross = roundValue(cost_gross_pennies / multiplier);
    const cost_vat = roundValue(cost_vat_pennies / multiplier);
    console.log(
      `Cost Calculation: Net: £${cost_net}, Gross: £${cost_gross}, VAT: £${cost_vat}`
    );
    console.log(
      `Cost Calculation (Pennies): Net: ${cost_net_pennies}, Gross: ${cost_gross_pennies}, VAT: ${cost_vat_pennies}`
    );
    const payload = {
      ...data,
      cost_net,
      cost_gross,
      cost_vat,
      currency,
      nc_ref: recordId,
      vat_rate: vatRateDecimal,
      created_at: new Date().toISOString(),
    };

    console.log("Submit:", payload);
    // Send to Supabase or backend
  };

  const vatOptions = [
    { id: "VAT Inclusive", name: "VAT Inclusive", value: "VAT Inclusive" },
    { id: "VAT Exclusive", name: "VAT Exclusive", value: "VAT Exclusive" },
    { id: "No VAT", name: "No VAT", value: "No VAT" },
  ];

  const typeOptions = [
    { id: 1, name: "Material", value: "Material" },
    { id: 2, name: "Labour", value: "Labour" },
    { id: 3, name: "Transport", value: "Transport" },
    { id: 4, name: "Admin", value: "Admin" },
    { id: 5, name: "Other", value: "Other" },
    { id: 6, name: "Overhead", value: "Overhead" },
    { id: 7, name: "Utilities", value: "Utilities" },
    { id: 8, name: "Depreciation", value: "Depreciation" },
    { id: 9, name: "Maintenance", value: "Maintenance" },
    { id: 10, name: "Insurance", value: "Insurance" },
    { id: 11, name: "Rent", value: "Rent" },
    { id: 12, name: "Licensing", value: "Licensing" },
    { id: 13, name: "Marketing", value: "Marketing" },
    { id: 14, name: "Training", value: "Training" },
    { id: 15, name: "Tools & Equipment", value: "Tools & Equipment" },
    { id: 16, name: "Consultancy", value: "Consultancy" },
    { id: 17, name: "IT Services", value: "IT Services" },
    { id: 18, name: "Packaging", value: "Packaging" },
    { id: 19, name: "Waste Disposal", value: "Waste Disposal" },
    { id: 20, name: "Compliance", value: "Compliance" },
  ];

  console.log(watch());

  return (
    <form className="w-180 p-6" onSubmit={(e) => e.preventDefault()}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-row gap-4">
          <div className="w-1/2">
            <Controller
              name="vat"
              control={control}
              render={({ field, fieldState }) => (
                <RHFComboBox
                  {...field}
                  error={fieldState.error}
                  placeholder="Select VAT Option"
                  options={vatOptions}
                  icon={HiOutlineReceiptTax}
                  label="VAT Option"
                  onChange={(value) => {
                    field.onChange(value);
                    if (value === "VAT Inclusive") {
                      setValue("cost_net", "");
                    } else if (value === "VAT Exclusive") {
                      setValue("cost_gross", "");
                    }
                  }}
                  value={field.value || ""}
                />
              )}
            />
          </div>

          <div className="w-3/5">
            <Controller
              name="currency"
              control={control}
              render={({ field, fieldState }) => (
                <CurrencyComboBox
                  {...field}
                  error={fieldState.error}
                  placeholder="Select a Currency"
                  options={currencyCodesArray || []}
                  icon={BsCurrencyExchange}
                  label="Currency"
                />
              )}
            />
          </div>
        </div>
        <div className="flex flex-row gap-4">
          <div className="w-1/2">
            <Controller
              name="type"
              control={control}
              render={({ field, fieldState }) => (
                <RHFComboBox
                  {...field}
                  error={fieldState.error}
                  placeholder="Select a cost type"
                  options={typeOptions || []}
                  icon={BiSolidCategoryAlt}
                  label="Cost Type"
                />
              )}
            />
          </div>
          {(watch("vat") === "VAT Inclusive" ||
            watch("vat") === "VAT Exclusive") && (
            <div className="w-50">
              <Controller
                name="vat_rate"
                control={control}
                render={({ field, fieldState }) => (
                  <TextInput
                    {...field}
                    error={fieldState.error}
                    dataType="number"
                    icon={HiOutlineReceiptTax}
                    label="VAT Rate"
                    placeholder="Enter VAT Rate"
                    suffix="%"
                    value={field.value ?? ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      field.onChange(val === "" ? undefined : parseFloat(val));
                    }}
                  />
                )}
              />
            </div>
          )}

          <div className="w-1/2">
            <Controller
              name="cost_amount"
              control={control}
              render={({ field, fieldState }) => {
                const vat = watch("vat");
                const label =
                  vat === "VAT Inclusive"
                    ? "Cost (Inc. VAT)"
                    : vat === "VAT Exclusive"
                    ? "Cost (Ex. VAT)"
                    : "Cost";
                const placeholder =
                  vat === "VAT Inclusive"
                    ? "Cost including VAT"
                    : vat === "VAT Exclusive"
                    ? "Cost excluding VAT"
                    : "Enter total cost";

                return (
                  <TextInput
                    {...field}
                    error={fieldState.error}
                    dataType="number"
                    icon={HiOutlineReceiptTax}
                    label={label}
                    placeholder={placeholder}
                    prefix="£"
                    value={field.value ?? ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      field.onChange(val === "" ? undefined : parseFloat(val));
                    }}
                  />
                );
              }}
            />
          </div>
        </div>
        <div className="flex flex-row gap-4"></div>
        <div className="flex flex-col gap-2">
          {watch("currency") !== base_currency &&
            watch("currency") !== null && (
              <div>{watch("currency")}/GBP - 1.23984</div>
            )}
          <div>Net Cost: £432.67</div>
          <div>Gross Cost: £432.67</div>
        </div>
        <div className="flex flex-row justify-end items-center">
          <CTAButton
            type="success"
            text="Save"
            icon={RiSave3Fill}
            callbackFn={handleSubmit(
              async (formData) => {
                if (!isValid) {
                  showToast({
                    type: "info",
                    title: "Validation Incomplete",
                    message: `Please correct form errors before saving. ${
                      formErrors
                        ? Object.values(formErrors)
                            .map((error) => error.message)
                            .join(", ")
                        : ""
                    }`,
                  });
                  return;
                }
                await onSubmit(formData, recordId);
              },
              (errors) => {
                showToast({
                  type: "info",
                  title: "Validation Incomplete",
                  message: `Please correct the following errors: ${Object.values(
                    errors
                  )
                    .map((error) => error.message)
                    .join(", ")}`,
                });
              }
            )}
          />
        </div>
      </div>
    </form>
  );
}
