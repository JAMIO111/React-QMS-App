import { useEffect, useState } from "react";
import { CircleAlertIcon, CircleCheckIcon, ListIcon, SearchIcon } from "@/components/icons";
import CTAButton from "../CTAButton";
import Dialog from "../ui/Dialog";
import Callout from "../ui/Callout";
import CopyButton from "../ui/CopyButton";
import { useReferenceValues } from "../../hooks/useIntegrations";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Why a value in the file has no match, in words. */
const reasonWords = (e, word) => (e.reason === "ambiguous" ? `more than one ${word} has this code` : `no ${word} has this code`);

/**
 * What the file's values for a link field came to against what exists in Fortress (the server checks up to 1,000 rows while the mapping is built). One line
 * under the field's row: green when every value is found, red with the first values that are not. Also the way into the list of allowed values.
 */
export const ReferenceCheckLine = ({ field, check, onOpen, matched }) => {
  if (!matched) {
    return (
      <div className="flex items-center gap-2 px-3 pb-2 text-xs text-secondary-text sm:pl-11">
        <button type="button" onClick={onOpen} className="inline-flex items-center gap-1 font-medium text-theme underline underline-offset-2">
          <ListIcon aria-hidden="true" /> See allowed {field.ref.kind === "unit" ? "units" : "values"}
        </button>
      </div>
    );
  }
  if (!check) return null;
  const bad = check.missing + check.ambiguous;
  if (check.distinct === 0) return null;
  return (
    <div role="status" data-reference-check={bad ? "problem" : "ok"} className={`flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2 text-xs sm:pl-11 ${bad ? "text-error-color" : "text-success-color"}`}>
      {bad ? <CircleAlertIcon className="shrink-0" aria-hidden="true" /> : <CircleCheckIcon className="shrink-0" aria-hidden="true" />}
      <span>
        {bad
          ? `${bad} of ${plural(check.distinct, "different value")} ${bad === 1 ? "is" : "are"} not usable as a ${check.word}: ${check.examples.slice(0, 3).map((e) => `"${e.value}"`).join(", ")}${bad > 3 ? ", …" : ""}`
          : `All ${plural(check.distinct, "different value")} in ${plural(check.checked, "row")} match a ${check.word} in Fortress`}
        {check.truncated ? " (the first 2,000 values were checked)" : ""}
      </span>
      <button type="button" onClick={onOpen} className="inline-flex items-center gap-1 font-medium text-theme underline underline-offset-2">
        <ListIcon aria-hidden="true" /> {bad ? "See the list" : "See allowed values"}
      </button>
    </div>
  );
};

/**
 * The values a link field accepts: the codes that exist in Fortress with their names, searchable, with the values from the file that do not match listed
 * first so they can be corrected in the file or the record can be made in Fortress first.
 */
const ReferenceValuesDialog = ({ field, check, onClose }) => {
  const kind = field.ref.kind;
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [limit, setLimit] = useState(50);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(q);
      setLimit(50);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const values = useReferenceValues(kind, { q: debounced, limit });
  const data = values.data?.data ?? [];
  const total = values.data?.total ?? 0;
  const word = values.data?.word ?? check?.word ?? "record";
  const bad = check?.examples ?? [];
  return (
    <Dialog title={`Allowed values for ${field.label}`} onClose={onClose} width="max-w-2xl">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">
          Use the code exactly as it is in Fortress (capitals do not matter). {field.ref.source ? "A value can also be the id your source gave the record when it was imported, if you choose to match that way. " : ""}A value with no match stops that row from being imported.
        </p>
        {bad.length > 0 && (
          <Callout tone="warning" title={`Values in your file with no match (${check.missing + check.ambiguous})`}>
            <ul className="mt-1 flex flex-col gap-0.5 text-sm" aria-label="Values in your file with no match">
              {bad.map((e) => (
                <li key={e.value}>
                  <span className="font-mono">{e.value}</span> — {reasonWords(e, check.word)}; {plural(e.rows, "row")}
                </li>
              ))}
              {check.missing + check.ambiguous > bad.length && <li>and {check.missing + check.ambiguous - bad.length} more</li>}
            </ul>
            <p className="mt-1 text-sm">Correct them in the file, or add the {check.word} to Fortress first, then read the file again.</p>
          </Callout>
        )}
        <label className="relative block">
          <span className="sr-only">Search the allowed values</span>
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tertiary-text" aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${word}s by code or name`}
            className="min-h-9.5 w-full rounded-lg border border-border-color bg-primary-bg py-2 pl-9 pr-3 text-sm text-primary-text"
          />
        </label>
        {values.isError ? (
          <Callout tone="error">The list could not be loaded{values.error?.message ? `: ${values.error.message}` : ""}.</Callout>
        ) : values.isLoading ? (
          <p role="status" className="text-sm text-secondary-text">Loading the list…</p>
        ) : data.length === 0 ? (
          <p className="text-sm text-secondary-text">{debounced ? `No ${word} matches "${debounced}".` : `There are no ${word}s in Fortress yet. Add them first, then link to them here.`}</p>
        ) : (
          <>
            <p className="text-xs text-secondary-text" aria-live="polite">{total > data.length ? `Showing ${data.length} of ${total}` : plural(total, word)}</p>
            <ul aria-label={`Allowed ${word} codes`} className="flex max-h-96 flex-col divide-y divide-border-color overflow-y-auto rounded-xl border border-border-color">
              {data.map((d) => (
                <li key={`${d.code}-${d.hint ?? ""}`} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-sm text-primary-text">{d.code}</span>
                    <span className="block truncate text-xs text-secondary-text">{[d.name, d.hint].filter(Boolean).join(" · ")}</span>
                  </span>
                  {d.duplicate && <span className="rounded-full bg-warning-color/15 px-2 py-0.5 text-xs text-warning-color" title="More than one department has this code, so it cannot be used on its own">used twice</span>}
                  {d.active === false && (
                    <span className="rounded-full bg-border-color px-2 py-0.5 text-xs text-secondary-text" title={kind === "nonconformance" ? "Cost lines are accepted on it only when the template allows costs on closed or cancelled non-conformances" : undefined}>
                      {kind === "nonconformance" ? "closed or cancelled" : "inactive"}
                    </span>
                  )}
                  <CopyButton text={d.code} label={`Copy ${d.code}`} />
                </li>
              ))}
            </ul>
            {total > data.length && (
              <div>
                <CTAButton type="neutral" size="md" onClick={() => setLimit((n) => n + 50)} loading={values.isFetching}>
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

export default ReferenceValuesDialog;
