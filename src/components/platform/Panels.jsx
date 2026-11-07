import MenuCard from "../ui/MenuCard";
import { ErrorNotice } from "../master-data/shared";
import { toneClass } from "./format";

/** One number with a label, for the rows of figures at the top of each tab. */
export const Tile = ({ label, value, hint, tone }) => (
  <div className={`flex flex-col gap-1 rounded-2xl border p-4 ${tone === "bad" ? "border-error-color" : tone === "warn" ? "border-warning-color" : "border-border-color"} bg-secondary-bg`}>
    <span className="text-xs text-secondary-text">{label}</span>
    <span className="text-2xl font-semibold text-primary-text">{value}</span>
    {hint ? <span className="text-xs text-secondary-text">{hint}</span> : null}
  </div>
);

export const Tiles = ({ children, label }) => (
  <div role="group" aria-label={label} className="grid grid-cols-2 gap-3 md:grid-cols-4">
    {children}
  </div>
);

export const Pill = ({ tone, children }) => <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${toneClass(tone)}`}>{children}</span>;

/** Loading, error and the content of a panel's query. */
export const Panel = ({ query, children }) => {
  if (query.error) return <ErrorNotice error={query.error} />;
  if (query.isLoading || !query.data) return <p className="text-sm text-secondary-text">Loading…</p>;
  return children(query.data);
};

export const Table = ({ caption, head, children, empty }) => (
  <div className="overflow-x-auto">
    {empty ? (
      <p className="text-sm text-secondary-text">{empty}</p>
    ) : (
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border-color text-secondary-text">
            {head.map((h) => (
              <th key={h} className="py-2 pr-3 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    )}
  </div>
);

export const Card = MenuCard;
