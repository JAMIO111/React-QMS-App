import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useCustomFieldPeople, useCustomFields } from "../../hooks/useCustomFields";
import { formatCustomValue } from "../../lib/customFields";

/**
 * Register columns for a kind of record's custom fields: one per active field, id `cf_<key>`, reading `row.customValues`, not sortable, hidden
 * until someone shows it (`defaultHidden`, to spread under the saved column visibility). Retired fields are left out.
 */
export const useCustomColumns = (entityType) => {
  const { data } = useCustomFields(entityType, { enabled: !!entityType });
  const fields = useMemo(() => (entityType ? (data?.data ?? []).filter((f) => f.active && f.entityType === entityType) : []), [data, entityType]);
  const { data: peopleList } = useCustomFieldPeople({ enabled: fields.some((f) => f.fieldType === "person") });
  return useMemo(() => {
    const people = Object.fromEntries((peopleList ?? []).map((p) => [p.id, p.name]));
    const columns = fields.map((f) => ({
      id: `cf_${f.key}`,
      header: f.label,
      accessorFn: (row) => formatCustomValue(f, row?.customValues?.[f.key], people),
      cell: (info) => info.getValue() || <span className="text-secondary-text">—</span>,
      enableSorting: false,
      size: f.fieldType === "long_text" ? 260 : 160,
      minSize: 80,
      maxSize: 600,
      meta: { customField: f.key, align: f.fieldType === "number" ? "right" : undefined },
    }));
    const defaultHidden = Object.fromEntries(columns.map((c) => [c.id, false]));
    return { columns, defaultHidden, fields };
  }, [fields, peopleList]);
};

/** The register's custom field filters in the address (`cf_<key>`): { params: { cf_key: value }, set(key, value), clearAll() }. */
export const useCustomFilterParams = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const params = {};
  for (const [k, v] of searchParams.entries()) if (/^cf_[a-z][a-z0-9_]{0,39}$/.test(k) && v) params[k] = v;
  const set = (key, value) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === "" || value == null) next.delete(`cf_${key}`);
      else next.set(`cf_${key}`, String(value));
      next.delete("page");
      return next;
    });
  const clearAll = () =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      [...next.keys()].filter((k) => k.startsWith("cf_")).forEach((k) => next.delete(k));
      next.delete("page");
      return next;
    });
  return { params, set, clearAll };
};

/** Words for one active custom filter, for a chip ("Coating: Paint, Zinc", "Weight: 5 to 10 kg", "Shift lead: none"). */
export const describeCustomFilter = (field, value, people = {}) => {
  if (value === "-") return `${field.label}: none`;
  const range = /^(.*)\.\.(.*)$/.exec(value);
  if (range && (field.fieldType === "number" || field.fieldType === "date")) {
    const [, lo, hi] = range;
    const unit = field.unit ? ` ${field.unit}` : "";
    if (lo && hi) return `${field.label}: ${lo} to ${hi}${unit}`;
    return lo ? `${field.label}: from ${lo}${unit}` : `${field.label}: up to ${hi}${unit}`;
  }
  if (field.fieldType === "boolean") return `${field.label}: ${value === "true" ? "Yes" : "No"}`;
  if (field.fieldType === "choice" || field.fieldType === "multi_choice")
    return `${field.label}: ${value.split(",").map((k) => field.options.find((o) => o.key === k)?.label ?? k).join(", ")}`;
  if (field.fieldType === "person") return `${field.label}: ${value.split(",").map((id) => people[id] ?? "someone").join(", ")}`;
  return `${field.label}: contains "${value}"`;
};

/**
 * Chips for the register's active custom field filters, in the shape registers use for their own ({ key, label, clearCustom }), plus `clearAll`
 * and `count`. `params` is what the list hook sends to the API.
 */
export const useCustomFilterChips = (entityType) => {
  const { data } = useCustomFields(entityType, { enabled: !!entityType });
  const fields = entityType ? (data?.data ?? []).filter((f) => f.entityType === entityType) : [];
  const { params, set, clearAll } = useCustomFilterParams();
  const { data: peopleList } = useCustomFieldPeople({ enabled: fields.some((f) => f.fieldType === "person") });
  const people = Object.fromEntries((peopleList ?? []).map((p) => [p.id, p.name]));
  const chips = Object.entries(params)
    .map(([k, v]) => {
      const field = fields.find((f) => `cf_${f.key}` === k);
      return field ? { key: k, label: describeCustomFilter(field, v, people), clearCustom: () => set(field.key, "") } : null;
    })
    .filter(Boolean);
  return { chips, params, clearAll, count: chips.length };
};

/** CSV columns for the custom fields of a row: { "<label>": text } for each active field. */
export const customCsvValues = (fields, row, people = {}) =>
  Object.fromEntries(fields.filter((f) => f.active).map((f) => [f.label, formatCustomValue(f, row?.customValues?.[f.key], people)]));
