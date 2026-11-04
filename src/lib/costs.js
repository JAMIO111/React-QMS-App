import currencyCodes from "../currencyCodes";

/** Cost categories (same keys as the API / database). */
export const COST_TYPES = [
  { id: "material", name: "Material" },
  { id: "labour", name: "Labour" },
  { id: "scrap", name: "Scrap" },
  { id: "rework", name: "Rework" },
  { id: "transport", name: "Transport" },
  { id: "inspection", name: "Inspection" },
  { id: "sorting", name: "Sorting / containment" },
  { id: "customer_charge", name: "Customer charge" },
  { id: "supplier_recovery", name: "Supplier recovery" },
  { id: "admin", name: "Admin" },
  { id: "tools_equipment", name: "Tools & equipment" },
  { id: "consultancy", name: "Consultancy" },
  { id: "packaging", name: "Packaging" },
  { id: "waste_disposal", name: "Waste disposal" },
  { id: "other", name: "Other" },
];
export const costTypeName = (id) => COST_TYPES.find((t) => t.id === id)?.name ?? id;

export const VAT_OPTIONS = [
  { id: "none", name: "No VAT" },
  { id: "inclusive", name: "VAT inclusive" },
  { id: "exclusive", name: "VAT exclusive" },
];

/** Currencies for a picker: [{ id: "GBP", name: "GBP – British Pound Sterling" }]. */
export const CURRENCY_OPTIONS = Object.values(currencyCodes)
  .map((c) => ({ id: c.code, name: `${c.code} – ${c.name}` }))
  .sort((a, b) => a.id.localeCompare(b.id));

export const currencySymbol = (code) => currencyCodes[code]?.symbol ?? code;

/** "£1,234.50" in the given currency. */
export const formatMoney = (amount, currency = "GBP") => {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return "—";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Net / VAT / gross for an entered amount, and the base-currency values — the same sums the
 * database does (app.ncr_cost_amounts), shown as a preview before saving.
 */
export const costAmounts = ({ amount, vatTreatment, vatRate, exchangeRate, currency }, baseCurrency) => {
  const value = Number(amount);
  if (amount === "" || amount === null || amount === undefined || Number.isNaN(value)) return null;
  const rate = vatTreatment === "none" ? 0 : Number(vatRate) || 0;
  let net;
  let gross;
  if (vatTreatment === "inclusive") {
    gross = round2(value);
    net = round2(value / (1 + rate));
  } else if (vatTreatment === "exclusive") {
    net = round2(value);
    gross = round2(value * (1 + rate));
  } else {
    net = round2(value);
    gross = net;
  }
  const fx = currency === baseCurrency ? 1 : Number(exchangeRate) || 0;
  return { net, vat: round2(gross - net), gross, netBase: round2(net * fx), grossBase: round2(gross * fx) };
};
