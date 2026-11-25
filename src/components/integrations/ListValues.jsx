import { useMemo, useState } from "react";
import { CircleAlertIcon, CircleCheckIcon, ListIcon, SearchIcon } from "@/components/icons";
import CTAButton from "../CTAButton";
import Dialog from "../ui/Dialog";
import Callout from "../ui/Callout";
import CopyButton from "../ui/CopyButton";
import { filterListValues, listAdvice, listValues } from "../../lib/listFields";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const LIMIT = 100;

/** "accepted values", "countries", "currencies": what the list is called on the link and in the dialog. */
const listWord = (field) => (field.type === "country" ? "countries" : field.type === "currency" ? "currencies" : "values");

/**
 * The line under a field that takes one of a list (a fixed choice, a custom choice, a country or a currency code): the example rows checked against the
 * list (green when every value is on it, red with the first values that are not) and the way into the list, as for links to other records.
 */
export const ListCheckLine = ({ field, check, matched, onOpen }) => {
  const open = (text) => (
    <button type="button" onClick={onOpen} className="inline-flex items-center gap-1 font-medium text-theme underline underline-offset-2">
      <ListIcon aria-hidden="true" /> {text}
    </button>
  );
  if (!matched || !check) {
    return <div className="flex items-center gap-2 px-3 pb-2 text-xs text-secondary-text sm:pl-11">{open(`See accepted ${listWord(field)}`)}</div>;
  }
  const bad = check.examples.length;
  return (
    <div role="status" data-list-check={bad ? "problem" : "ok"} className={`flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2 text-xs sm:pl-11 ${bad ? "text-error-color" : "text-success-color"}`}>
      {bad ? <CircleAlertIcon className="shrink-0" aria-hidden="true" /> : <CircleCheckIcon className="shrink-0" aria-hidden="true" />}
      <span>
        {bad
          ? `${check.badRows} of the ${plural(check.checked, "example row")} ${check.badRows === 1 ? "has a value" : "have values"} not on the list: ${check.examples.slice(0, 3).map((e) => `"${e.value}"`).join(", ")}${bad > 3 ? ", …" : ""}`
          : `Every value in the ${plural(check.checked, "example row")} is on the list`}
      </span>
      {open(bad ? "See the list" : `See accepted ${listWord(field)}`)}
    </div>
  );
};

/** The values a list field accepts, searchable, with each one's code to copy and the example rows' values that are not on it listed first. */
const ListValuesDialog = ({ field, check, onClose }) => {
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(LIMIT);
  const all = useMemo(() => listValues(field), [field]);
  const shown = filterListValues(all, q);
  const bad = check?.examples ?? [];
  const codes = field.type === "country" || field.type === "currency";
  return (
    <Dialog title={`Accepted ${listWord(field)} for ${field.label}`} onClose={onClose} width="max-w-2xl">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">{listAdvice(field)}</p>
        {bad.length > 0 && (
          <Callout tone="warning" title={`Values in the example rows not on the list (${bad.length})`}>
            <ul className="mt-1 flex flex-col gap-0.5 text-sm" aria-label="Values not on the list">
              {bad.map((e) => (
                <li key={e.value}>
                  <span className="font-mono">{e.value}</span> — {plural(e.rows, "row")}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-sm">Correct them in the source, or translate them in the row's settings. Only the rows shown in the preview are checked here.</p>
          </Callout>
        )}
        {all.length > 8 && (
          <label className="relative block">
            <span className="sr-only">Search the accepted values</span>
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tertiary-text" aria-hidden="true" />
            <input
              type="search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setLimit(LIMIT);
              }}
              placeholder={codes ? "Search by code or name" : "Search by words or code"}
              className="min-h-9.5 w-full rounded-lg border border-border-color bg-primary-bg py-2 pl-9 pr-3 text-sm text-primary-text"
            />
          </label>
        )}
        {shown.length === 0 ? (
          <p className="text-sm text-secondary-text">{q ? `Nothing on the list matches "${q}".` : "This field has no values to choose from."}</p>
        ) : (
          <>
            <p className="text-xs text-secondary-text" aria-live="polite">{shown.length > limit ? `Showing ${limit} of ${shown.length}` : plural(shown.length, "value")}</p>
            <ul aria-label={`Accepted values for ${field.label}`} className="flex max-h-96 flex-col divide-y divide-border-color overflow-y-auto rounded-xl border border-border-color">
              {shown.slice(0, limit).map((v) => (
                <li key={v.value} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    {codes ? (
                      <>
                        <span className="block truncate font-mono text-sm text-primary-text">{v.value}</span>
                        <span className="block truncate text-xs text-secondary-text">{v.label}</span>
                      </>
                    ) : (
                      <>
                        <span className="block truncate text-sm text-primary-text">{v.label}</span>
                        {v.value.toLowerCase() !== v.label.toLowerCase() && <span className="block truncate font-mono text-xs text-secondary-text">{v.value}</span>}
                      </>
                    )}
                  </span>
                  <CopyButton text={codes ? v.value : v.label} label={`Copy ${codes ? v.value : v.label}`} />
                </li>
              ))}
            </ul>
            {shown.length > limit && (
              <div>
                <CTAButton type="neutral" size="md" onClick={() => setLimit((n) => n + LIMIT)}>
                  Show more
                </CTAButton>
              </div>
            )}
          </>
        )}
        <div className="flex justify-end">
          <CTAButton type="secondary" size="md" onClick={onClose}>
            Close
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

export default ListValuesDialog;
