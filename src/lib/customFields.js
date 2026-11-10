/**
 * Custom fields: the organisation's own extra fields on 13 kinds of record (docs/custom-fields-plan.md). The database checks every value;
 * these helpers only describe, format and prepare them for the screens.
 */

export const CUSTOM_FIELD_LIMIT = 20;

/** The kinds of record, in the order the Settings page offers them, with the permission that edits them (the database decides again). */
export const CUSTOM_FIELD_ENTITIES = [
  { value: "part", label: "Parts" },
  { value: "part_family", label: "Part families" },
  { value: "machine", label: "Machines" },
  { value: "customer", label: "Customers" },
  { value: "supplier", label: "Suppliers" },
  { value: "employee", label: "Employees" },
  { value: "gauge_type", label: "Gauge types" },
  { value: "gauge", label: "Gauges" },
  { value: "nonconformance", label: "Non-conformances" },
  { value: "capa", label: "8Ds" },
  { value: "inspection", label: "Inspections" },
  { value: "production_order", label: "Production orders" },
  { value: "lot", label: "Lots" },
];
export const entityLabel = (value) => CUSTOM_FIELD_ENTITIES.find((e) => e.value === value)?.label ?? value;

/** Field types with what they hold. */
export const FIELD_TYPES = [
  { value: "text", label: "Short text", hint: "Up to 500 characters" },
  { value: "long_text", label: "Long text", hint: "Up to 5,000 characters, several lines" },
  { value: "number", label: "Number", hint: "Optional decimals, unit and limits" },
  { value: "date", label: "Date", hint: "A calendar date" },
  { value: "boolean", label: "Yes / no", hint: "A switch" },
  { value: "choice", label: "One choice", hint: "Pick one from a list" },
  { value: "multi_choice", label: "Several choices", hint: "Pick any from a list" },
  { value: "person", label: "Person", hint: "A member of the organisation" },
];
export const fieldTypeLabel = (value) => FIELD_TYPES.find((t) => t.value === value)?.label ?? value;
export const isListType = (type) => type === "choice" || type === "multi_choice";

/** "When is it required?" choices for a kind of record: never, on save, then each of its stages ("before it reaches …"). */
export const requiredChoices = (stages = []) => [
  { value: "never", label: "Not required" },
  { value: "save", label: "Required when the record is saved" },
  ...stages.map((s) => ({ value: s.value, label: `Required before it reaches ${s.label}` })),
];
export const requiredLabel = (requiredAt, stages = []) => {
  if (requiredAt === "never") return null;
  if (requiredAt === "save") return "Required";
  const stage = stages.find((s) => s.value === requiredAt);
  return `Required by ${stage?.label ?? requiredAt.replace(/_/g, " ")}`;
};

/** A key (lower case, digits, _) made from a label, as the database makes one. */
export const keyFromLabel = (label) => {
  let k = String(label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  if (!/^[a-z]/.test(k)) k = `field_${k}`.replace(/_+$/, "");
  return k;
};
export const optionKeyFromLabel = (label, taken = []) => {
  const base = String(label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36) || "option";
  let key = base;
  let n = 2;
  while (taken.includes(key)) key = `${base}_${n++}`;
  return key;
};

/** Problems with a field being edited, in words, before it is sent (the database checks again). */
export const fieldProblems = (f) => {
  const out = [];
  if (!f.label?.trim()) out.push("Give the field a label");
  if (isListType(f.fieldType)) {
    const opts = (f.options ?? []).filter((o) => o.label.trim());
    if (opts.length === 0) out.push("Add at least one option");
    const labels = opts.map((o) => o.label.trim().toLowerCase());
    if (new Set(labels).size !== labels.length) out.push("Two options have the same label");
  }
  if (f.fieldType === "number") {
    const min = f.min === "" || f.min == null ? null : Number(f.min);
    const max = f.max === "" || f.max == null ? null : Number(f.max);
    if ((min !== null && Number.isNaN(min)) || (max !== null && Number.isNaN(max))) out.push("Limits must be numbers");
    else if (min !== null && max !== null && min > max) out.push("The lowest value is above the highest");
  }
  return out;
};

/** The body for POST / PATCH /custom-fields from the dialog's state. */
export const fieldBody = (f, { creating }) => {
  const body = {
    label: f.label.trim(),
    helpText: f.helpText?.trim() || null,
    section: f.section?.trim() || null,
    requiredAt: f.requiredAt || "never",
  };
  if (creating) {
    body.fieldType = f.fieldType;
    body.entityType = f.entityType;
  }
  if (isListType(f.fieldType)) body.options = f.options.filter((o) => o.label.trim()).map((o) => ({ key: o.key, label: o.label.trim(), active: o.active !== false }));
  if (f.fieldType === "number") {
    const n = (v) => (v === "" || v == null ? null : Number(v));
    body.decimals = f.decimals === "" || f.decimals == null ? null : Number(f.decimals);
    body.unit = f.unit?.trim() || null;
    body.min = n(f.min);
    body.max = n(f.max);
  }
  return body;
};

/** The dialog's state for a field (new: the defaults for a kind of record). */
export const fieldToForm = (d, entityType) =>
  d
    ? {
        entityType: d.entityType,
        fieldType: d.fieldType,
        label: d.label,
        helpText: d.helpText ?? "",
        section: d.section ?? "",
        requiredAt: d.requiredAt,
        options: d.options.map((o) => ({ ...o, saved: true })),
        decimals: d.decimals ?? "",
        unit: d.unit ?? "",
        min: d.min ?? "",
        max: d.max ?? "",
      }
    : { entityType, fieldType: "text", label: "", helpText: "", section: "", requiredAt: "never", options: [], decimals: "", unit: "", min: "", max: "" };

/** A stored value as words for reading (people: from `people`, a map of id → name). */
export const formatCustomValue = (field, value, people = {}) => {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) return "";
  switch (field.fieldType) {
    case "boolean":
      return value ? "Yes" : "No";
    case "number": {
      const n = Number(value);
      const text = field.decimals != null ? n.toFixed(field.decimals) : String(n);
      return field.unit ? `${text} ${field.unit}` : text;
    }
    case "date": {
      const [y, m, d] = String(value).split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    }
    case "choice":
      return field.options.find((o) => o.key === value)?.label ?? String(value);
    case "multi_choice":
      return (Array.isArray(value) ? value : [value]).map((k) => field.options.find((o) => o.key === k)?.label ?? k).join(", ");
    case "person":
      return people[value] ?? "Unknown person";
    default:
      return String(value);
  }
};

/** Whether a record is missing a value needed now (on save) or for a stage still ahead / reached. */
export const isMissing = (value) => value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

/** Fields grouped by section in display order: [{ section, fields }] (fields without a section first, under "Other details" only when there are sections). */
export const groupBySection = (fields) => {
  const groups = new Map();
  for (const f of fields) {
    const key = f.section || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return [...groups.entries()].map(([section, list]) => ({ section, fields: list }));
};

/** Query-string pairs for register filters on custom fields (`cf_<key>`). */
export const customFilterParams = (filters = {}) =>
  Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [`cf_${k}`, String(v)]));

/** `{ customValues }` for a create body when any value was given, else nothing (so the body stays as it was). */
export const withCustomValues = (values) => (values && Object.keys(values).length ? { customValues: values } : {});
