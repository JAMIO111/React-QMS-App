import { countryOptions } from "./onboarding";
import { CURRENCY_OPTIONS } from "./costs";

/**
 * Import fields that take one value of a list (or several, for a custom "several choices" field): a fixed choice (`enum`, a custom choice field), a
 * custom several-choices field (`multiple` with `options`), a country code or a currency code. The mapping editor shows the list in a pop-up, as it does
 * for links to other records, and checks the example rows against it. The rules mirror how the import reads the value (`api/src/integrations/core/mapping.ts`
 * and `app.import_custom_values`), so what is flagged here is what the import would refuse.
 */
export const isListField = (field) => !field?.ref && Boolean(field?.type === "enum" || field?.type === "country" || field?.type === "currency" || (field?.multiple && field?.options?.length > 0));

const COUNTRIES = () => countryOptions().map((c) => ({ value: c.id, label: c.name }));
const CURRENCIES = () => CURRENCY_OPTIONS.map((c) => ({ value: c.id, label: c.name.replace(/^[A-Z]{3} – /, "") }));

/** The values a list field accepts, as { value, label }: the code the import keeps and the words people read. */
export const listValues = (field) => {
  if (field?.type === "country") return COUNTRIES();
  if (field?.type === "currency") return CURRENCIES();
  return field?.options ?? [];
};

/** Whether a fixed choice / custom choice may be written by its code or its words (both are; capitals and spaces do not matter for the code). */
const choiceOk = (options, raw) => {
  const s = raw.toLowerCase().replace(/[\s-]+/g, "_");
  return options.some((o) => o.value === s || o.value.toLowerCase() === raw.toLowerCase() || o.label.toLowerCase() === raw.toLowerCase());
};

/** Whether one value read from the source would be accepted (an empty value is left to the field's own "when empty" rule, so it is fine here). */
export const listValueOk = (field, value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return true;
  if (field.type === "country") return /^[A-Za-z]{2}$/.test(raw);
  if (field.type === "currency") return /^[A-Za-z]{3}$/.test(raw);
  if (field.multiple) return raw.split(/[,;]/).map((p) => p.trim()).filter(Boolean).every((p) => choiceOk(field.options ?? [], p));
  return choiceOk(field.options ?? [], raw);
};

/** The value a preview field came to before it was checked: after the last step, else as taken from the source. */
const readValue = (f) => (f.steps?.length ? f.steps[f.steps.length - 1] : f.taken);

/**
 * The example rows the server previewed, checked against the list: how many rows had a value, and the values that are not accepted with how many rows
 * hold each (most first). Null when no row of the preview has this field.
 */
export const listCheck = (field, previewRows = []) => {
  let checked = 0;
  const bad = new Map();
  for (const r of previewRows) {
    const f = r.fields?.find((x) => x.target === field.key);
    if (!f) continue;
    const v = readValue(f);
    if (v === null || v === undefined || String(v).trim() === "") continue;
    checked += 1;
    if (!listValueOk(field, v)) bad.set(String(v).trim(), (bad.get(String(v).trim()) ?? 0) + 1);
  }
  if (!checked) return null;
  const examples = [...bad].map(([value, rows]) => ({ value, rows })).sort((a, b) => b.rows - a.rows || a.value.localeCompare(b.value));
  return { checked, badRows: examples.reduce((n, e) => n + e.rows, 0), examples };
};

/** What to tell people about writing the value, by kind of list. */
export const listAdvice = (field) => {
  if (field.type === "country") return "Write the two-letter country code (capitals do not matter). Any two-letter code is accepted; these are the countries it stands for.";
  if (field.type === "currency") return "Write the three-letter currency code (capitals do not matter).";
  if (field.multiple) return "Write one or more of these, separated by commas or semicolons, by their words or their code (capitals do not matter). A value not on the list stops that row from being imported.";
  return "Write one of these, by its words or its code (capitals do not matter). A value not on the list stops that row from being imported. If your source uses other words, translate them in the row's settings.";
};

/** Search the list by words or code. */
export const filterListValues = (values, q) => {
  const s = q.trim().toLowerCase();
  if (!s) return values;
  return values.filter((v) => v.label.toLowerCase().includes(s) || v.value.toLowerCase().includes(s));
};
