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

/** A unit price: pennies as usual, up to four decimals when it has them (fasteners at £0.0035 each). */
export const formatUnitMoney = (amount, currency = "GBP") => {
  if (amount === null || amount === undefined || amount === "" || Number.isNaN(Number(amount))) return "—";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(amount);
  } catch {
    return `${currency} ${Number(amount)}`;
  }
};

/** A quantity as people write it: no trailing zeros, up to four decimals. */
export const formatQuantity = (q) => (q === null || q === undefined || q === "" || Number.isNaN(Number(q)) ? "—" : new Intl.NumberFormat("en-GB", { maximumFractionDigits: 4 }).format(q));

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

/** Cost types that bring money back (a recovery from a supplier, a charge to a customer): they reduce the NC's cost, so totals take them off. */
export const CREDIT_COST_TYPES = ["supplier_recovery", "customer_charge"];
export const isCreditType = (costType) => CREDIT_COST_TYPES.includes(costType);

/** What a line's rate is, in the words people see. */
export const RATE_STATUS = {
  base: "Same currency",
  estimated: "Estimated",
  actual: "Actual",
  needed: "Rate needed",
};

/** A rate as written: up to six significant digits, no trailing zeros. */
export const formatRate = (rate) => (rate === null || rate === undefined || Number.isNaN(Number(rate)) ? "—" : new Intl.NumberFormat("en-GB", { maximumSignificantDigits: 6 }).format(rate));

/** A line's converted value with its sign: credits are negative. Null while the rate is needed. */
export const signedBase = (cost, field = "netBase") => (cost[field] === null || cost[field] === undefined ? null : round2(cost[field] * (cost.costSign ?? 1)));

/** Whether the totals rest on published rates, stated ones or both: "estimated" | "actual" | "mixed" | null (every line in the site currency). */
export const totalsRateState = (rates) => {
  if (!rates) return null;
  if (rates.estimated > 0 && rates.actual > 0) return "mixed";
  if (rates.estimated > 0) return "estimated";
  if (rates.actual > 0) return "actual";
  return null;
};

/** "€240.00 + −£20.00": what was actually spent, in each currency (the NC's totals' byCurrency). */
export const spentInEachCurrency = (byCurrency) => (byCurrency ?? []).map((c) => formatMoney(c.net, c.currency)).join(" + ");

/** How far a stated rate is from the published one, as a signed percentage ("+5.9%"); null when there is nothing to compare. */
export const rateDifference = (stated, published) => {
  if (!stated || !published) return null;
  const pct = ((stated - published) / published) * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`;
};
