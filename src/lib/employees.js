/**
 * An employee from `GET /employees/lookup` as a combo box option with their circle on the left: their profile picture when the employee is
 * linked to a sign-in that has one, else their initials. `extra` adds or overrides fields (e.g. a hint or a name with "(left)").
 *
 *   employeeOption(e)                      → RHFComboBox option { id, name, hint, avatar }
 *   employeeOption(e, { as: "field" })     → ComboField option { value, label, hint, avatar }
 */
export const employeeOption = (employee, { as = "combo", ...extra } = {}) => {
  const avatar = { name: employee.name, path: employee.avatarPath ?? null };
  const hint = employee.jobTitle ?? undefined;
  const base = as === "field" ? { value: employee.id, label: employee.name, hint, avatar } : { id: employee.id, name: employee.name, hint, avatar };
  return { ...base, ...extra };
};

/** Up to two letters: the first of the first and of the last word ("Ada Lovelace" → "AL", "Cher" → "C"). */
export const initialsOf = (name) => {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = words[0].charAt(0);
  const last = words.length > 1 ? words[words.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
};

/**
 * The circle for a member (someone with a sign-in) in a combo box option: `avatar: avatarOf(p)` where `p` has `name` (or pass the name) and the
 * `avatarPath` the people lists return. Shows their profile picture when they have one, else their initials.
 */
export const avatarOf = (person, name) => ({ name: name ?? person?.name ?? "", path: person?.avatarPath ?? null });
