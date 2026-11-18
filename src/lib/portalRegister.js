// Search, filter and sort for the portal registers (components/portal/PortalRegister.jsx), kept apart so they can be tested on their own.

export const list = (v) => (v ? v.split(",").filter(Boolean) : []);

/** The rows that pass the search and every filter. Exported for tests. */
export const applyFilters = (rows, { filters = [], params, search, searchText }) => {
  const q = (search ?? "").trim().toLowerCase();
  return rows.filter((row) => {
    if (q && !(searchText?.(row) ?? "").toLowerCase().includes(q)) return false;
    return filters.every((f) => {
      if (f.type === "pills") {
        const chosen = list(params.get(`f.${f.key}`));
        return chosen.length === 0 || chosen.includes(f.value(row));
      }
      if (f.type === "dates") {
        const from = params.get(`d.${f.key}.from`);
        const to = params.get(`d.${f.key}.to`);
        if (!from && !to) return true;
        const day = f.value(row);
        if (!day) return false;
        const d = String(day).slice(0, 10);
        return (!from || d >= from) && (!to || d <= to);
      }
      if (f.type === "switch") return params.get(`s.${f.key}`) !== "1" || f.test(row);
      return true;
    });
  });
};

const compare = (a, b) => {
  const empty = (v) => v === null || v === undefined || v === "";
  if (empty(a) && empty(b)) return 0;
  if (empty(a)) return 1; // empty values last whichever way it is sorted (handled by the caller for descending)
  if (empty(b)) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
};

/** Sort by the chosen column's own value. Exported for tests. */
export const sortRows = (rows, sorting, columns) => {
  const s = sorting?.[0];
  const col = s && columns.find((c) => c.id === s.id);
  if (!col?.accessorFn) return rows;
  const empty = (v) => v === null || v === undefined || v === "";
  return [...rows].sort((x, y) => {
    const a = col.accessorFn(x);
    const b = col.accessorFn(y);
    if (empty(a) !== empty(b)) return empty(a) ? 1 : -1;
    const c = compare(a, b);
    return s.desc ? -c : c;
  });
};

