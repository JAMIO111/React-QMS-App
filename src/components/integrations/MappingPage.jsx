import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useToast } from "../../contexts/ToastProvider";
import {
  useIntegrationConnection,
  useIntegrationEntities,
  useIntegrationFile,
  useIntegrationFiles,
  useIntegrationMappings,
  useIntegrationMutation,
} from "../../hooks/useIntegrations";
import { usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { DATE_FORMAT_OPTIONS, MATCH_OPTIONS, TRANSFORM_OPTIONS, mappingToRows, rowsToFields } from "../../lib/integrations";
import { formatDateTime } from "../../lib/processControl";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import { ErrorNotice, TextAreaField } from "../master-data/shared";
import ImportSettingsCard from "./ImportSettingsCard";
import CTAButton from "@/components/CTAButton";

const TYPE_HINTS = { date: "date", number: "number", integer: "whole number", boolean: "yes / no", email: "email", url: "web address", enum: "one of a list" };

/** The limits the database sets for a field, in words ("Up to 20 characters", "From 1 to 1000"). */
const fieldLimits = (f) => {
  if (f.ref) return null;
  if ((f.type === "number" || f.type === "integer") && (f.min != null || f.max != null)) {
    if (f.min != null && f.max != null) return `From ${f.min} to ${f.max}`;
    if (f.min == null) return `At most ${f.max}`;
    return f.minExclusive ? `More than ${f.min}` : `At least ${f.min}`;
  }
  return f.maxLength ? `Up to ${f.maxLength} characters` : null;
};

/** One Fortress field: whether it is used, where its value comes from and how it is cleaned. */
const FieldRow = ({ field, row, columns, onChange, readOnly }) => {
  const set = (patch) => onChange({ ...row, ...patch });
  const colOptions = columns.map((c) => ({ value: c, label: c }));
  const id = `use-${field.key}`;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border-color p-3" aria-label={field.label}>
      <div className="flex flex-wrap items-center gap-2">
        <input id={id} type="checkbox" checked={row.on} disabled={readOnly || field.required} onChange={(e) => set({ on: e.target.checked })} className="h-4 w-4" />
        <label htmlFor={id} className="text-sm font-medium text-primary-text" data-required={field.required || undefined}>{field.label}</label>
        {TYPE_HINTS[field.type] && <span className="text-xs text-secondary-text">({TYPE_HINTS[field.type]})</span>}
        {field.description && <span className="text-xs text-secondary-text">· {field.description}</span>}
      </div>
      {field.options && row.on && <p className="text-xs text-secondary-text">Accepted values: {field.options.map((o) => o.value).join(", ")}</p>}
      {row.on && fieldLimits(field) && <p className="text-xs text-secondary-text">{fieldLimits(field)}</p>}
      {row.on && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <ComboField label="How" value={row.transform} onChange={(v) => set({ transform: v ?? "none" })} options={TRANSFORM_OPTIONS} required disabled={readOnly} />
          {row.transform === "constant" ? (
            <Field label="Value" value={row.value} onChange={(e) => set({ value: e.target.value })} required disabled={readOnly} />
          ) : row.transform === "concat" ? (
            <div className="flex flex-col gap-1 sm:col-span-2">
              <ComboField
                label="Add a column"
                value={null}
                onChange={(v) => v && set({ sources: [...row.sources, v] })}
                options={colOptions.filter((o) => !row.sources.includes(o.value))}
                disabled={readOnly}
              />
              <div className="flex flex-wrap items-center gap-1">
                {row.sources.map((s) => (
                  <span key={s} className="inline-flex items-center gap-1 rounded-full bg-border-color px-2 py-0.5 text-xs text-primary-text">
                    {s}
                    {!readOnly && <button type="button" aria-label={`Remove ${s}`} onClick={() => set({ sources: row.sources.filter((x) => x !== s) })}>×</button>}
                  </span>
                ))}
              </div>
              <Field label="Put between them" value={row.separator} onChange={(e) => set({ separator: e.target.value })} disabled={readOnly} />
            </div>
          ) : (
            <ComboField label="Column" value={row.source} onChange={(v) => set({ source: v })} options={colOptions} disabled={readOnly} required={!row.default} />
          )}
          {row.transform !== "constant" && row.transform !== "concat" && (
            <Field label="When empty, use" value={row.default} onChange={(e) => set({ default: e.target.value })} disabled={readOnly} />
          )}
          {row.transform === "map" && (
            <TextAreaField
              label="Translate (one per line: value in the file=value in Fortress)"
              value={row.valuesText}
              onChange={(e) => set({ valuesText: e.target.value })}
              rows={3}
              required
              disabled={readOnly}
              className="sm:col-span-3"
            />
          )}
          {field.type === "date" && row.transform !== "constant" && (
            <ComboField label="Dates written as" value={row.dateFormat} onChange={(v) => set({ dateFormat: v ?? "iso" })} options={DATE_FORMAT_OPTIONS} required disabled={readOnly} />
          )}
          {field.ref?.source && row.transform !== "constant" && row.transform !== "concat" && (
            <ComboField
              label="Match by"
              value={row.match}
              onChange={(v) => set({ match: v ?? "code" })}
              options={MATCH_OPTIONS}
              hint={row.match === "source" ? "The id the source gave it when it was imported here" : "The code as it is in Fortress"}
              required
              disabled={readOnly}
            />
          )}
          {(field.type === "number" || field.type === "integer") && row.transform !== "constant" && (
            <ComboField label="Decimal mark" value={row.decimal} onChange={(v) => set({ decimal: v ?? "." })} options={[{ value: ".", label: "Point (1.5)" }, { value: ",", label: "Comma (1,5)" }]} required disabled={readOnly} />
          )}
        </div>
      )}
    </li>
  );
};

/** The first rows of the file, to check the columns while mapping. */
const Sample = ({ file }) => {
  const rows = file.sample.slice(0, 5);
  if (!rows.length) return <p className="text-sm text-secondary-text">The rows of this file have been cleared.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-xs" aria-label="First rows">
        <thead>
          <tr>
            <th className="px-2 py-1 text-secondary-text">Row</th>
            {file.headers.map((h) => <th key={h} className="whitespace-nowrap px-2 py-1 text-secondary-text">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.row} className="border-t border-border-color">
              <td className="px-2 py-1 text-secondary-text">{r.row}</td>
              {file.headers.map((h) => <td key={h} className="whitespace-nowrap px-2 py-1 text-primary-text">{r.values[h]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/**
 * Map a file connection's columns to Fortress fields for one kind of record. Each save is a new version (a reason once one exists); a preview of the chosen
 * file can be started from here and shows what would be created, updated or rejected. Nothing is written to Fortress records by mapping or previewing.
 */
const MappingPage = () => {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { showToast } = useToast();
  const connection = useIntegrationConnection(id);
  const entities = useIntegrationEntities();
  const files = useIntegrationFiles(id);
  const parsed = useMemo(() => (files.data ?? []).filter((f) => f.status === "parsed"), [files.data]);
  const entityType = params.get("entity") ?? entities.data?.[0]?.entityType ?? null;
  const fileId = params.get("file") ?? parsed[0]?.id ?? null;
  const file = useIntegrationFile(fileId);
  const mappings = useIntegrationMappings(id, entityType);
  const mutation = useIntegrationMutation();
  const catalogue = entities.data?.find((e) => e.entityType === entityType);
  const versions = mappings.data ?? [];
  const current = versions.find((v) => v.current) ?? null;
  const headers = file.data?.headers ?? [];

  const [form, setForm] = useState(null);
  const [problems, setProblems] = useState([]);
  // Start again whenever the kind of record, the saved version or the file changes.
  const formKey = `${entityType}|${current?.id ?? "none"}|${fileId ?? "none"}|${catalogue ? 1 : 0}|${file.data ? 1 : 0}|${mappings.isSuccess ? 1 : 0}`;
  useEffect(() => {
    if (!catalogue || !mappings.isSuccess || (fileId && !file.data)) return;
    const guessKey = current?.keyField ?? headers.find((h) => /^(id|code|number|ref|reference|key)$/i.test(h.trim())) ?? headers[0] ?? null;
    setForm({ keyField: guessKey, rows: mappingToRows(catalogue.fields, current, headers), reason: "" });
    setProblems([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey]);

  useBreadcrumbNames([{ path: `/Settings/Integrations/${id}`, label: connection.data?.name }]);
  if (connection.isLoading || entities.isLoading || files.isLoading) return <LoadingScreen />;
  const err = connection.error ?? entities.error ?? files.error;
  if (err) return <div className="p-4"><ErrorNotice error={err} /></div>;

  const c = connection.data;
  const readOnly = !can("integrations.manage") || c.status === "retired";
  const canRun = can("integrations.run") && c.status !== "retired";
  const setParam = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  // Columns to choose from: the file's, plus any the saved mapping names (so a mapping can be read without its file).
  const used = current ? [current.keyField, ...current.fields.flatMap((f) => [f.source, ...(f.sources ?? [])])].filter(Boolean) : [];
  const columns = [...new Set([...headers, ...used])];

  const save = (e) => {
    e.preventDefault();
    if (!form) return;
    const body = { entityType, keyField: form.keyField ?? "", fields: rowsToFields(form.rows, catalogue.fields), ...(form.reason.trim() ? { reason: form.reason.trim() } : {}), ...(fileId ? { fileId } : {}) };
    mutation.mutate(
      { action: "saveMapping", id, body },
      {
        onSuccess: (res) => {
          setProblems([]);
          const v = res.data?.find((m) => m.current);
          showToast({ type: "success", title: `Mapping saved as version ${v?.version ?? ""}`.trim() });
        },
        onError: (error) => setProblems(error.details?.problems ?? [describeApiError(error)]),
      },
    );
  };
  const preview = () =>
    mutation.mutate(
      { action: "requestRun", id, body: { entityType, kind: "preview", fileId } },
      {
        onSuccess: (run) => navigate(`/Settings/Integrations/${id}/runs/${run.id}`),
        onError: (error) => showToast({ type: "error", title: "Preview not started", message: describeApiError(error) }),
      },
    );

  return (
    <div className="flex flex-col gap-4 p-4">
      <MenuCard title="Map columns" subtitle={`${c.name}: say which column of the file goes into which Fortress field. Saving keeps every earlier version.`}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ComboField
            label="Records"
            value={entityType}
            onChange={(v) => setParam("entity", v)}
            options={(entities.data ?? []).map((e) => ({ value: e.entityType, label: e.label }))}
            required
          />
          <ComboField
            label="File"
            value={fileId}
            onChange={(v) => setParam("file", v)}
            options={parsed.map((f) => ({ value: f.id, label: f.fileName, hint: `${f.rowCount} rows · ${formatDateTime(f.uploadedAt)}` }))}
            hint="Its columns are offered below"
            clearable
          />
        </div>
        {parsed.length === 0 && <Callout tone="info" className="mt-3">Upload a file on the connection page first: its column headings are what you map.</Callout>}
        {current && <p className="mt-3 text-sm text-secondary-text">In use: version {current.version}, saved {formatDateTime(current.createdAt)}{current.createdBy ? ` by ${current.createdBy.name}` : ""}.</p>}
      </MenuCard>

      {catalogue && <ImportSettingsCard connection={c} entityType={entityType} readOnly={readOnly} />}

      {file.data && (
        <MenuCard title="First rows of the file" subtitle={`${file.data.fileName} · ${file.data.rowCount} rows`}>
          <Sample file={file.data} />
        </MenuCard>
      )}

      {catalogue && form && columns.length > 0 && (
        <MenuCard as="form" noValidate onSubmit={save} title={catalogue.label} subtitle={catalogue.keyHint}>
          <div className="flex flex-col gap-3">
            <ComboField
              label="Column that identifies each record"
              value={form.keyField}
              onChange={(v) => setForm({ ...form, keyField: v })}
              options={columns.map((h) => ({ value: h, label: h }))}
              hint="The same record keeps the same value in every file, so a later import updates it instead of adding another"
              required
              disabled={readOnly}
            />
            <ul aria-label="Fields" className="flex flex-col gap-2">
              {catalogue.fields.map((f, i) => (
                <FieldRow
                  key={f.key}
                  field={f}
                  row={form.rows[i]}
                  columns={columns}
                  readOnly={readOnly}
                  onChange={(row) => setForm({ ...form, rows: form.rows.map((r, j) => (j === i ? row : r)) })}
                />
              ))}
            </ul>
            {!readOnly && current && (
              <TextAreaField label="Why is the mapping changing?" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} rows={2} maxLength={1000} required hint={`It becomes version ${current.version + 1}`} />
            )}
            {problems.length > 0 && (
              <Callout tone="error" title="The mapping was not saved">
                <ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
              </Callout>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              {canRun && current && fileId && (
                <CTAButton buttonType="button" type="secondary" size="md" onClick={preview} disabled={mutation.isPending}>Preview this file</CTAButton>
              )}
              {!readOnly && (
                <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending || (current && form.reason.trim().length < 3)}>
                  {mutation.isPending ? "Saving…" : current ? "Save as a new version" : "Save mapping"}
                </CTAButton>
              )}
            </div>
          </div>
        </MenuCard>
      )}

      {versions.length > 0 && (
        <MenuCard title="Versions" subtitle="Every saved mapping of this kind of record, newest first. Each import says which version it used.">
          <ul aria-label="Versions" className="flex flex-col divide-y divide-border-color">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-baseline gap-2 py-1.5 text-sm">
                <span className="font-medium text-primary-text">Version {v.version}{v.current ? " (in use)" : ""}</span>
                <span className="text-secondary-text">{v.fields.length} fields · key {v.keyField}</span>
                {v.reason && <span className="text-secondary-text">· {v.reason}</span>}
                <span className="ml-auto text-xs text-secondary-text">{formatDateTime(v.createdAt)}{v.createdBy ? ` · ${v.createdBy.name}` : ""}</span>
              </li>
            ))}
          </ul>
        </MenuCard>
      )}
    </div>
  );
};

export default MappingPage;
