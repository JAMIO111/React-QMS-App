import { useState } from "react";
import { useToast } from "../../../contexts/ToastProvider";
import { useIntegrationEntities, useIntegrationMutation } from "../../../hooks/useIntegrations";
import { describeApiError } from "../../../lib/api-client";
import { ENTITY_LABELS, restSourceBody, restSourceForm, restSourceProblem, restTryRequest } from "../../../lib/integrations";
import { PlusIcon, Trash2Icon } from "@/components/icons";
import ComboField from "../../ui/ComboField";
import Dialog from "../../ui/Dialog";
import Field from "../../ui/Field";
import MenuCard from "../../ui/MenuCard";
import { FormError } from "../../master-data/shared";
import { Failed, useAsk, Waiting } from "./agentAsk";
import CTAButton from "@/components/CTAButton";

const PAGING = [
  { value: "none", label: "One answer holds every record" },
  { value: "page", label: "Page numbers" },
  { value: "offset", label: "Offset and limit" },
  { value: "cursor", label: "A cursor from the answer" },
  { value: "next_link", label: "A link to the next page" },
];

/** Names the API pages with, by style, with what the agent sends when nothing is given (as the cloud REST connector). */
const PARAM_WORDS = {
  page: { param: "Page number parameter", paramHint: "page when empty", size: "Page size parameter", sizeHint: "per_page when empty" },
  offset: { param: "Offset parameter", paramHint: "offset when empty", size: "Limit parameter", sizeHint: "limit when empty" },
  cursor: { param: "Cursor parameter", paramHint: "cursor when empty", size: "Page size parameter", sizeHint: "Optional" },
  next_link: { size: "Page size parameter", sizeHint: "Optional" },
};

/**
 * Where records are on an internal API (AG5c): a path below the connection's address, where the list is in the answer, fixed parameters and how it
 * pages. The same settings as a cloud REST connection; the agent reads it inside the network.
 */
export const EndpointFields = ({ f, set }) => {
  const words = PARAM_WORDS[f.pagingStyle];
  const setQuery = (i, patch) => set({ query: f.query.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Path" value={f.path} onChange={(e) => set({ path: e.target.value })} required maxLength={300} placeholder="/v1/machines"
          hint="Below the connection's address, starting with /" />
        <Field label="Where the list is in the answer" value={f.recordsPath} onChange={(e) => set({ recordsPath: e.target.value })} maxLength={600} placeholder="data"
          hint="Keys joined by dots, e.g. data or value; empty when the answer is the list" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-primary-text">Fixed parameters</span>
        {f.query.length === 0 && <p className="text-sm text-secondary-text">None: the path is asked as it is.</p>}
        {f.query.map((x, i) => (
          <div key={i} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Field label={`Parameter ${i + 1}`} value={x.name} onChange={(e) => setQuery(i, { name: e.target.value })} maxLength={60} />
            <Field label="Value" value={x.value} onChange={(e) => setQuery(i, { value: e.target.value })} maxLength={200} />
            <CTAButton type="neutral" size="md" aria-label={`Remove parameter ${i + 1}`} onClick={() => set({ query: f.query.filter((_, j) => j !== i) })}>
              <Trash2Icon />
            </CTAButton>
          </div>
        ))}
        {f.query.length < 20 && (
          <CTAButton type="secondary" size="md" className="self-start" onClick={() => set({ query: [...f.query, { name: "", value: "" }] })}>
            <PlusIcon /> Add a parameter
          </CTAButton>
        )}
      </div>
      <ComboField label="How the API pages" value={f.pagingStyle} onChange={(v) => v && set({ pagingStyle: v })} options={PAGING} required />
      {f.pagingStyle !== "none" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Records per page" type="number" value={f.pageSize} onChange={(e) => set({ pageSize: e.target.value })} placeholder="100" hint="1 to 1,000" />
          {words?.param && <Field label={words.param} value={f.pageParam} onChange={(e) => set({ pageParam: e.target.value })} maxLength={60} hint={words.paramHint} />}
          {words?.size && <Field label={words.size} value={f.sizeParam} onChange={(e) => set({ sizeParam: e.target.value })} maxLength={60} hint={words.sizeHint} />}
          {f.pagingStyle === "cursor" && (
            <Field label="Where the answer gives the next cursor" value={f.nextPath} onChange={(e) => set({ nextPath: e.target.value })} required maxLength={600} placeholder="meta.next" />
          )}
          {f.pagingStyle === "next_link" && (
            <Field label="Where the answer gives the next link" value={f.nextPath} onChange={(e) => set({ nextPath: e.target.value })} maxLength={600} placeholder="@odata.nextLink"
              hint="Empty: the Link header. The link must stay on the same address." />
          )}
        </div>
      )}
    </div>
  );
};

const cell = (v) => (v === null || v === undefined || v === "" ? <span className="text-secondary-text">—</span> : String(v));

/**
 * Try an address on an internal API through the agent (AG5c): the agent asks for the first page and sends back its records, flattened to columns
 * ("site.code") as an import will read them. Fortress never calls the API itself. Then use the address for a kind of record.
 */
export const RestTryCard = ({ connection: c }) => {
  const preview = useAsk(c.id);
  const [f, setF] = useState(() => restSourceForm({}));
  const [tried, setTried] = useState(false);
  const [using, setUsing] = useState(false);
  if (c.agent?.status !== "active") return null;
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const problem = restSourceProblem(f);
  const done = preview.job?.status === "completed";
  const result = done ? preview.job.result : null;
  const tryIt = () => {
    setTried(true);
    if (problem) return;
    preview.ask("preview", { ...restTryRequest(f), limit: 20 });
  };
  return (
    <MenuCard title="Try an address" subtitle="The agent asks the API for the first page and shows its records as an import reads them. Nothing is saved.">
      <div className="flex flex-col gap-4">
        <EndpointFields f={f} set={set} />
        {tried && problem && <p className="text-sm text-error-color" role="alert">{problem}</p>}
        <div className="flex flex-wrap gap-2">
          <CTAButton type="main" size="md" onClick={tryIt} loading={preview.busy} loadingText="Asking the agent…">Try this address</CTAButton>
          {done && result.columns.length > 0 && (
            <CTAButton type="secondary" size="md" onClick={() => setUsing(true)}>Use this address</CTAButton>
          )}
        </div>
        {preview.busy && <Waiting job={preview.job} />}
        {preview.job?.status === "failed" && <Failed job={preview.job} />}
        {done && (
          <div className="overflow-x-auto rounded-xl border border-border-color">
            <table aria-label={`First records of ${result.path}`} className="min-w-full text-sm">
              <thead className="bg-secondary-bg text-left text-xs text-secondary-text">
                <tr>{result.columns.map((col) => <th key={col.name} className="whitespace-nowrap px-2 py-1 font-medium">{col.name}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-border-color">
                {result.rows.map((row, i) => (
                  <tr key={i}>{result.columns.map((col) => <td key={col.name} className="whitespace-nowrap px-2 py-1 text-primary-text">{cell(row[col.name])}</td>)}</tr>
                ))}
              </tbody>
            </table>
            <p className="p-2 text-xs text-secondary-text">
              {result.rows.length === 0 ? "The first page holds no records." : `${result.pageRecords ?? result.rows.length} record${(result.pageRecords ?? result.rows.length) === 1 ? "" : "s"} on the first page`}
              {result.morePages ? "; there are more pages" : ""}
            </p>
          </div>
        )}
      </div>
      {using && done && <RestSourceDialog connection={c} initial={f} columns={result.columns.map((x) => x.name)} onClose={() => setUsing(false)} />}
    </MenuCard>
  );
};

/**
 * Say which address a kind of record is read from on an internal API (AG5c), the field that identifies each record and, to read only what changed,
 * the field that shows it with the parameter that asks the API for records changed since a value. Opened from an address just tried (its columns
 * offered) or to change a saved endpoint.
 */
export const RestSourceDialog = ({ connection, initial = null, columns = null, existing = null, onClose }) => {
  const mutation = useIntegrationMutation();
  const entities = useIntegrationEntities();
  const { showToast } = useToast();
  const used = new Set((connection.recordSources ?? []).map((s) => s.entityType));
  const [entityType, setEntityType] = useState(existing?.entityType ?? null);
  const [f, setF] = useState(() => {
    const base = existing ? restSourceForm(existing.source) : { ...initial };
    const guess = columns?.find((x) => /^(id|code|number|key)$/i.test(x)) ?? columns?.[0] ?? null;
    return { ...base, keyColumn: base.keyColumn ?? guess };
  });
  const [tried, setTried] = useState(false);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const kinds = (entities.data ?? []).filter((e) => !used.has(e.entityType) || e.entityType === existing?.entityType);
  const options = columns ? columns.map((n) => ({ value: n, label: n })) : null;
  const problem = (!entityType && "Choose which Fortress records this address gives") || restSourceProblem(f, true);
  const save = (e) => {
    e.preventDefault();
    setTried(true);
    if (problem) return;
    const source = restSourceBody(f);
    mutation.mutate(
      { action: "setRecordSource", id: connection.id, body: { entityType, source } },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Saved", message: `${ENTITY_LABELS[entityType] ?? entityType} are read from ${source.path}.` });
          onClose();
        },
        onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
      },
    );
  };
  return (
    <Dialog title="Read records from the API" onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">
          The connector agent asks the API for this address page by page and sends Fortress each record as flat columns. Fortress never calls the API itself.
        </p>
        <ComboField
          label="Fortress records at this address"
          value={entityType}
          onChange={setEntityType}
          options={kinds.map((k) => ({ value: k.entityType, label: k.label ?? ENTITY_LABELS[k.entityType] ?? k.entityType }))}
          required
          disabled={!!existing}
          hint={existing ? "To read another kind of record, use an address again for it" : "Each kind of record is read from one address"}
        />
        <EndpointFields f={f} set={set} />
        {options ? (
          <>
            <ComboField label="Field that identifies each record" value={f.keyColumn} onChange={(v) => set({ keyColumn: v })} options={options} required
              hint="The same record keeps the same value every time it is read, so importing again updates it instead of adding another." />
            <ComboField label="Field that shows when a record changed" value={f.changedColumn} onChange={(v) => set({ changedColumn: v ?? null })} options={options} clearable
              hint="Optional: a date-and-time or number the API moves on whenever the record changes." />
          </>
        ) : (
          <>
            <Field label="Field that identifies each record" value={f.keyColumn ?? ""} onChange={(e) => set({ keyColumn: e.target.value || null })} required maxLength={200}
              hint="As the record shows it, e.g. code or site.code" />
            <Field label="Field that shows when a record changed" value={f.changedColumn ?? ""} onChange={(e) => set({ changedColumn: e.target.value || null })} maxLength={200}
              hint="Optional, e.g. updatedAt" />
          </>
        )}
        {f.changedColumn && (
          <Field label="Parameter that asks for records changed since" value={f.changedParam} onChange={(e) => set({ changedParam: e.target.value })} required maxLength={60}
            placeholder="modifiedSince" hint="An incremental import sends this parameter with the highest value read last time, and the API answers only what changed since." />
        )}
        {tried && problem && <p className="text-sm text-error-color" role="alert">{problem}</p>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" loading={mutation.isPending}>Save</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};
