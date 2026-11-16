import { useEffect, useState } from "react";
import { useToast } from "../../../contexts/ToastProvider";
import { useIntegrationEntities, useIntegrationMutation } from "../../../hooks/useIntegrations";
import { usePermissions } from "../../../hooks/useQmsApi";
import { describeApiError } from "../../../lib/api-client";
import { ENTITY_LABELS, FILTER_OPS, apiMappingPath, describeRecordSource, fileNameProblem, isFolderConfig, isRestConfig, recordSourceBody, recordSourceForm, recordSourceProblem } from "../../../lib/integrations";
import { formatDateTime } from "../../../lib/processControl";
import { PlusIcon, Trash2Icon } from "@/components/icons";
import Callout from "../../ui/Callout";
import ComboField from "../../ui/ComboField";
import Dialog from "../../ui/Dialog";
import Field from "../../ui/Field";
import MenuCard from "../../ui/MenuCard";
import SlidingToggle from "../../ui/SlidingToggle";
import RowActionsMenu from "../../ui/RowActionsMenu";
import { FormError } from "../../master-data/shared";
import { Failed, useAsk, Waiting } from "./agentAsk";
import { RestSourceDialog } from "./RestSources";
import CTAButton from "@/components/CTAButton";

/**
 * Say which table or view a kind of Fortress record is read from (docs/connector-agent-plan.md AG3): the column that identifies each row, which
 * columns (all, or a choice) and simple filters. It is a structured request: the agent checks every name against the database and builds its
 * own read-only SELECT. Opened from a table just browsed (`shape` given), or to change a saved source (its columns are asked of the agent).
 */
export const RecordSourceDialog = ({ connection, schema, object, shape: given = null, existing = null, onClose }) => {
  const mutation = useIntegrationMutation();
  const entities = useIntegrationEntities();
  const { showToast } = useToast();
  const ask = useAsk(connection.id);
  const asked = ask.job?.status === "completed" ? { columns: ask.job.result.columns } : null;
  const shape = given ?? asked;
  useEffect(() => {
    if (!given) ask.ask("discover", { level: "columns", schema, object });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const used = new Set((connection.recordSources ?? []).map((s) => s.entityType));
  const [entityType, setEntityType] = useState(existing?.entityType ?? null);
  const [f, setF] = useState(() => (existing ? recordSourceForm(existing.source) : given ? recordSourceForm(null, given) : null));
  useEffect(() => {
    if (!f && shape) setF(recordSourceForm(existing?.source ?? null, shape));
  }, [f, shape, existing]);
  const [tried, setTried] = useState(false);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const names = (shape?.columns ?? []).map((c) => c.name);
  const colOptions = (shape?.columns ?? []).map((c) => ({ value: c.name, label: c.name, hint: `${c.type}${c.primaryKey ? " · key" : ""}` }));
  const kinds = (entities.data ?? []).filter((e) => !used.has(e.entityType) || e.entityType === existing?.entityType);
  const problem = (!entityType && "Choose which Fortress records this table holds") || (f && recordSourceProblem(f));

  const save = (e) => {
    e.preventDefault();
    setTried(true);
    if (problem || !f) return;
    mutation.mutate(
      { action: "setRecordSource", id: connection.id, body: { entityType, source: recordSourceBody(schema, object, f) } },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Saved", message: `${ENTITY_LABELS[entityType] ?? entityType} are read from ${schema}.${object}.` });
          onClose();
        },
        onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
      },
    );
  };
  const toggleColumn = (name) => set({ columns: f.columns.includes(name) ? f.columns.filter((c) => c !== name) : names.filter((n) => n === name || f.columns.includes(n)) });
  const setFilter = (i, patch) => set({ filters: f.filters.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  return (
    <Dialog title={`Read records from ${schema}.${object}`} onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">
          The connector agent reads this table, a page at a time in the order of the column that identifies each row, and sends Fortress only the columns
          and rows chosen here. Fortress never sends SQL.
        </p>
        <ComboField
          label="Fortress records in this table"
          value={entityType}
          onChange={setEntityType}
          options={kinds.map((k) => ({ value: k.entityType, label: k.label ?? ENTITY_LABELS[k.entityType] ?? k.entityType }))}
          required
          disabled={!!existing}
          hint={existing ? "To read another kind of record, choose this table again for it" : "Each kind of record is read from one table or view"}
        />
        {!shape && ask.busy && <Waiting job={ask.job} />}
        {!shape && ask.job?.status === "failed" && <Failed job={ask.job} />}
        {shape && f && (
          <>
            <ComboField label="Column that identifies each row" value={f.keyColumn} onChange={(v) => set({ keyColumn: v })} options={colOptions} required
              hint="The same row keeps the same value every time it is read, so importing again updates it instead of adding another. Rows with no value here are not read." />
            <ComboField label="Column that shows when a row changed" value={f.changedColumn} onChange={(v) => set({ changedColumn: v ?? null })} options={colOptions} clearable
              hint="Optional: a date-and-time (or a number) the database moves on whenever the row changes. With it, an incremental import reads only the rows changed since the last one." />
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-primary-text">Columns to read</span>
              <SlidingToggle ariaLabel="Columns to read" options={[{ value: "all", label: "All columns" }, { value: "chosen", label: "Choose" }]}
                value={f.allColumns ? "all" : "chosen"} onChange={(v) => set({ allColumns: v === "all" })} />
              {!f.allColumns && (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Columns">
                  {names.map((n) => (
                    <button key={n} type="button" aria-pressed={f.columns.includes(n)} onClick={() => toggleColumn(n)}
                      className={`min-h-9.5 rounded-full border px-3 text-sm ${f.columns.includes(n) ? "border-theme bg-theme-light font-medium text-primary-text" : "border-border-color text-secondary-text hover:bg-secondary-bg"}`}>
                      {n}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-primary-text">Only rows where</span>
              {f.filters.length === 0 && <p className="text-sm text-secondary-text">Every row is read.</p>}
              {f.filters.map((x, i) => {
                const noValue = FILTER_OPS.find((o) => o.value === x.op)?.noValue;
                return (
                  <div key={i} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                    <ComboField label={`Filter ${i + 1} column`} value={x.column} onChange={(v) => setFilter(i, { column: v })} options={colOptions} required />
                    <ComboField label="Test" value={x.op} onChange={(v) => v && setFilter(i, { op: v })} options={FILTER_OPS.map((o) => ({ value: o.value, label: o.label }))} required />
                    {noValue ? <div /> : <Field label="Value" value={x.value} onChange={(e) => setFilter(i, { value: e.target.value })} required maxLength={200} />}
                    <CTAButton type="neutral" size="md" aria-label={`Remove filter ${i + 1}`} onClick={() => set({ filters: f.filters.filter((_, j) => j !== i) })}>
                      <Trash2Icon />
                    </CTAButton>
                  </div>
                );
              })}
              {f.filters.length < 10 && (
                <CTAButton type="secondary" size="md" className="self-start" onClick={() => set({ filters: [...f.filters, { column: null, op: "eq", value: "" }] })}>
                  <PlusIcon /> Add a filter
                </CTAButton>
              )}
            </div>
          </>
        )}
        {tried && problem && <p className="text-sm text-error-color" role="alert">{problem}</p>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" loading={mutation.isPending} disabled={!shape}>Save</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/**
 * Say which file in a folder a kind of record is read from (AG5b): a name, or a pattern with * that picks the newest of a series of dated exports.
 * The agent sends the newest matching CSV or Excel file and Fortress reads it as it reads uploaded files.
 */
export const FileSourceDialog = ({ connection, initialName = "", existing = null, onClose }) => {
  const mutation = useIntegrationMutation();
  const entities = useIntegrationEntities();
  const { showToast } = useToast();
  const used = new Set((connection.recordSources ?? []).map((s) => s.entityType));
  const [entityType, setEntityType] = useState(existing?.entityType ?? null);
  const [name, setName] = useState(existing?.source?.file ?? initialName);
  const [tried, setTried] = useState(false);
  const kinds = (entities.data ?? []).filter((e) => !used.has(e.entityType) || e.entityType === existing?.entityType);
  const problem = (!entityType && "Choose which Fortress records this file holds") || fileNameProblem(name);
  const save = (e) => {
    e.preventDefault();
    setTried(true);
    if (problem) return;
    mutation.mutate(
      { action: "setRecordSource", id: connection.id, body: { entityType, source: { file: name } } },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Saved", message: `${ENTITY_LABELS[entityType] ?? entityType} are read from the newest file matching ${name}.` });
          onClose();
        },
        onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
      },
    );
  };
  return (
    <Dialog title="Read records from a file" onClose={onClose} width="max-w-xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">
          Each import reads the newest CSV or Excel file in the folder whose name matches. An incremental import reads it only when it has changed since the last one.
        </p>
        <ComboField
          label="Fortress records in this file"
          value={entityType}
          onChange={setEntityType}
          options={kinds.map((k) => ({ value: k.entityType, label: k.label ?? ENTITY_LABELS[k.entityType] ?? k.entityType }))}
          required
          disabled={!!existing}
          hint={existing ? "To read another kind of record, choose a file again for it" : "Each kind of record is read from one file name or pattern"}
        />
        <Field
          label="File name or pattern"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={200}
          hint="Use * for the part that changes, e.g. machines-*.csv for machines-2026-11-15.csv, machines-2026-11-16.csv …"
        />
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

/** Which table each kind of record is read from, with a way to map its fields, change it or stop reading it. */
export const RecordSourcesCard = ({ connection: c }) => {
  const { can } = usePermissions();
  const mutation = useIntegrationMutation();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(null);
  const canManage = can("integrations.manage");
  const sources = c.recordSources ?? [];
  const folder = isFolderConfig(c.config);
  const api = isRestConfig(c.config);
  const remove = (s) =>
    mutation.mutate(
      { action: "setRecordSource", id: c.id, body: { entityType: s.entityType, source: null } },
      { onError: (err) => showToast({ type: "error", title: "Not removed", message: describeApiError(err) }) },
    );
  return (
    <MenuCard
      title={api ? "Records read from the API" : folder ? "Records read from the folder" : "Records read from the database"}
      subtitle={api ? "For each kind of Fortress record, the address the agent reads it from." : folder ? "For each kind of Fortress record, the file the agent picks up for it." : "For each kind of Fortress record, the table or view the agent reads it from."}>
      {sources.length === 0 ? (
        api ? (
          <Callout tone="info">Try an address below, then <strong>Use this address</strong> for the records it gives.</Callout>
        ) : folder ? (
          <Callout tone="info">List the files below, then <strong>Use this file</strong> for the records it holds.</Callout>
        ) : (
          <Callout tone="info">Browse the database below, choose a table or view, then <strong>Use this table</strong> for the records it holds.</Callout>
        )
      ) : (
        <ul aria-label="Record sources" className="flex flex-col divide-y divide-border-color">
          {sources.map((s) => (
            <li key={s.entityType} className="flex flex-wrap items-center gap-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium text-primary-text">{ENTITY_LABELS[s.entityType] ?? s.entityType}</span>
                <span className="text-sm text-secondary-text">{describeRecordSource(s.source)}</span>
                <span className="text-xs text-secondary-text">Changed {formatDateTime(s.updatedAt)}</span>
              </div>
              <CTAButton to={apiMappingPath(c.id, s.entityType)} type="secondary" size="md">Map fields</CTAButton>
              {canManage && c.status !== "retired" && (
                <RowActionsMenu
                  label={`Actions for ${ENTITY_LABELS[s.entityType] ?? s.entityType}`}
                  items={[
                    { label: "Change", onSelect: () => setEditing(s) },
                    { label: "Stop reading", tone: "danger", onSelect: () => remove(s) },
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && editing.source.file && <FileSourceDialog connection={c} existing={editing} onClose={() => setEditing(null)} />}
      {editing && editing.source.path && <RestSourceDialog connection={c} existing={editing} onClose={() => setEditing(null)} />}
      {editing && !editing.source.file && !editing.source.path && <RecordSourceDialog connection={c} schema={editing.source.schema} object={editing.source.object} existing={editing} onClose={() => setEditing(null)} />}
    </MenuCard>
  );
};
