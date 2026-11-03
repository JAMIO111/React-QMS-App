import { useEffect, useId, useState } from "react";
import { useParts, usePart, useParties } from "../../hooks/useMasterData";

export const selectClass =
  "w-full rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-primary-text shadow-s focus:outline-none focus:border-brand-primary disabled:opacity-60";

/** Labelled <select> matching Field's look. options: [{ value, label }]. */
export const SelectField = ({ label, value, onChange, options, disabled, placeholder = "— None —", required, hint, className = "" }) => {
  const id = useId();
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-primary-text">
        {label}
        {required && <span className="text-error-color"> *</span>}
      </label>
      <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} disabled={disabled} className={selectClass}>
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <p className="text-xs text-secondary-text">{hint}</p>}
    </div>
  );
};

export const TextAreaField = ({ label, value, onChange, disabled, rows = 3, maxLength, className = "" }) => {
  const id = useId();
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-primary-text">
        {label}
      </label>
      <textarea
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={rows}
        maxLength={maxLength}
        className="rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-primary-text shadow-s focus:outline-none focus:border-brand-primary disabled:opacity-60"
      />
    </div>
  );
};

/**
 * Part search: type to search (server-side), pick from the matches. The current part stays listed
 * even when it does not match the search.
 */
export const PartPicker = ({ value, current, onChange, disabled }) => {
  const id = useId();
  const [term, setTerm] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(term.trim()), 300);
    return () => clearTimeout(t);
  }, [term]);
  const parts = useParts({ q });
  const items = parts.data?.items ?? [];
  const options = [...items];
  if (current && !items.some((p) => p.id === current.id)) options.unshift(current);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-primary-text">
        Part
      </label>
      <div className="flex gap-2">
        {!disabled && (
          <input
            type="search"
            aria-label="Search parts"
            placeholder="Search…"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            className="w-28 rounded-lg border border-border-color bg-text-input-color px-2 py-2 text-sm text-primary-text focus:outline-none focus:border-brand-primary"
          />
        )}
        <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} disabled={disabled} className={selectClass}>
          <option value="">— None —</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.partNumber} · {p.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};

/** Revisions of the chosen part (released first); obsolete ones are not offered for new records. */
export const RevisionPicker = ({ partId, value, onChange, disabled }) => {
  const part = usePart(partId);
  const revisions = part.data?.revisions ?? [];
  const order = { released: 0, draft: 1, superseded: 2, obsolete: 3 };
  const options = [...revisions]
    .sort((a, b) => order[a.status] - order[b.status])
    .map((r) => ({ value: r.id, label: `${r.revision} (${r.status})`, disabled: r.status === "obsolete" && r.id !== value }));
  return (
    <SelectField
      label="Revision"
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled || !partId}
      placeholder={partId ? "— None —" : "Choose a part first"}
    />
  );
};

/** Customer or supplier picker (kind: "customers" | "suppliers"). */
export const PartyPicker = ({ kind, label, value, current, onChange, disabled, required }) => {
  const parties = useParties(kind, {});
  const items = parties.data?.items ?? [];
  const options = items.map((p) => ({ value: p.id, label: `${p.code} · ${p.displayName ?? p.name}` }));
  if (current && !items.some((p) => p.id === current.id)) options.unshift({ value: current.id, label: current.name });
  return <SelectField label={label} value={value} onChange={onChange} options={options} disabled={disabled} required={required} />;
};
