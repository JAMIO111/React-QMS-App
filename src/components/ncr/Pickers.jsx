import { useEffect, useId, useState } from "react";
import RHFComboBox from "../ui/RHFComboBox";
import { useParts, usePart, useParties } from "../../hooks/useMasterData";
import { useNcrs } from "../../hooks/useNcr";

export const TextAreaField = ({ label, value, onChange, disabled, rows = 3, maxLength, className = "" }) => {
  const id = useId();
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-secondary-text">
        {label}
      </label>
      <textarea
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={rows}
        maxLength={maxLength}
        className="rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-primary-text outline-none transition-all duration-150 placeholder:text-sm placeholder:text-muted hover:border-border-dark-color focus:border-brand-primary focus:ring-3 focus:ring-brand-primary/20 disabled:opacity-60"
      />
    </div>
  );
};

/** Search term typed into a combo box, debounced for the server. */
const useDebouncedSearch = (delay = 300) => {
  const [term, setTerm] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(term.trim()), delay);
    return () => clearTimeout(t);
  }, [term, delay]);
  return [q, setTerm];
};

/**
 * RHFComboBox over a server-searched list. Remembers the chosen option, and takes `current`
 * ({ id, name }) for a saved value, so the name still shows when a later search does not list it.
 * Field props from react-hook-form (value, onChange, onBlur, name, ref) pass straight through.
 */
export const RemoteComboBox = ({ items, isFetching, onSearch, current, value, onChange, ...props }) => {
  const [picked, setPicked] = useState(null);
  const known = picked?.id === value ? picked : current?.id === value ? current : undefined;
  return (
    <RHFComboBox
      {...props}
      value={value}
      options={items}
      selectedOption={known}
      sort={false}
      filterLocally={false}
      onSearchChange={onSearch}
      emptyMessage={isFetching ? "Searching…" : "No matches"}
      onChange={(id) => {
        const item = items.find((i) => i.id === id) ?? null;
        setPicked(item);
        onChange(id, item);
      }}
    />
  );
};

const partOption = (p) => ({ id: p.id, name: p.name ? `${p.partNumber} · ${p.name}` : p.partNumber });

/** Part search (server-side). `current` is the saved part ({ id, partNumber, name }). */
export const PartPicker = ({ current, label = "Part", ...props }) => {
  const [q, setSearch] = useDebouncedSearch();
  const parts = useParts({ q });
  return (
    <RemoteComboBox
      {...props}
      label={label}
      placeholder="Search part number or name…"
      items={(parts.data?.items ?? []).map(partOption)}
      isFetching={parts.isFetching}
      onSearch={setSearch}
      current={current ? partOption(current) : undefined}
    />
  );
};

/** Revisions of the chosen part, released first; obsolete ones cannot be picked for a new value. */
export const RevisionPicker = ({ partId, value, disabled, label = "Revision", ...props }) => {
  const part = usePart(partId);
  const order = { released: 0, draft: 1, superseded: 2, obsolete: 3 };
  const options = [...(part.data?.revisions ?? [])]
    .sort((a, b) => order[a.status] - order[b.status])
    .map((r) => ({ id: r.id, name: r.revision, hint: r.status[0].toUpperCase() + r.status.slice(1), disabled: r.status === "obsolete" && r.id !== value }));
  return (
    <RHFComboBox
      {...props}
      label={label}
      value={value}
      options={options}
      sort={false}
      disabled={disabled || !partId}
      placeholder={partId ? "Select a revision…" : "Choose a part first"}
    />
  );
};

/** Non-conformance search by reference or title. onChange(id, item) with item { id, name, source }. */
export const NcrPicker = ({ label = "Non-conformance", ...props }) => {
  const [q, setSearch] = useDebouncedSearch();
  const ncrs = useNcrs({ q, pageSize: 10 });
  return (
    <RemoteComboBox
      {...props}
      label={label}
      placeholder="Search reference or title…"
      items={(ncrs.data?.data ?? []).map((n) => ({ id: n.id, name: `${n.reference} · ${n.title}`, source: n.source }))}
      isFetching={ncrs.isFetching}
      onSearch={setSearch}
    />
  );
};

const partyOption = (p) => ({ id: p.id, name: p.displayName ?? p.name, hint: p.code });

/** Customer or supplier search (kind: "customers" | "suppliers"). `current` is the saved { id, name }. */
export const PartyPicker = ({ kind, current, ...props }) => {
  const [q, setSearch] = useDebouncedSearch();
  const parties = useParties(kind, { q });
  return (
    <RemoteComboBox
      {...props}
      placeholder={`Search ${kind}…`}
      items={(parties.data?.items ?? []).map(partyOption)}
      isFetching={parties.isFetching}
      onSearch={setSearch}
      current={current ? { id: current.id, name: current.name } : undefined}
    />
  );
};
