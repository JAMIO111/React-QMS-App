/** Supplier risk scoring: the four score levels a factor can have (1 low … 4 critical). The database works out the index, band and rating. */
export const RISK_LEVELS = [
  { value: 1, label: "Low" },
  { value: 2, label: "Medium" },
  { value: 3, label: "High" },
  { value: 4, label: "Critical" },
];

/** A stable factor key from a name: lower-case words joined by underscores (2 to 40 characters). */
export const factorKey = (label, taken = []) => {
  const base = (label || "factor").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36) || "factor";
  let key = base.length < 2 ? `${base}_x` : base;
  for (let n = 2; taken.includes(key); n += 1) key = `${base}_${n}`.slice(0, 40);
  return key;
};
