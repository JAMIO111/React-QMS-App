import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { uploadFileToSupabase } from "../../api/supabaseApi";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useToast } from "../../contexts/ToastProvider";
import {
  useIntegrationConnection,
  useIntegrationConnections,
  useIntegrationEntities,
  useIntegrationFile,
  useIntegrationFiles,
  useIntegrationMappings,
  useIntegrationMutation,
} from "../../hooks/useIntegrations";
import { usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import {
  DELIMITERS,
  ENCODINGS,
  ENTITY_DESCRIPTIONS,
  ENTITY_LABELS,
  fileProblem,
  freeSystemCode,
  mappingChanged,
  mappingToRows,
  rowHasSource,
  rowsInUse,
  rowsToFields,
} from "../../lib/integrations";
import { formatDateTime } from "../../lib/processControl";
import { CheckIcon } from "@/components/icons";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import { FileIcon } from "../ui/FileDrop";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import Switch from "../ui/Switch";
import { ErrorNotice, TextAreaField } from "../master-data/shared";
import ImportSettingsCard from "./ImportSettingsCard";
import MappingStep from "./MappingStep";
import ProviderLogo from "./ProviderLogo";
import CTAButton from "@/components/CTAButton";

const STEPS = [
  { n: 1, label: "Choose records" },
  { n: 2, label: "Upload a file" },
  { n: 3, label: "Map columns" },
];
const ACCEPT = ".csv,.txt,.xlsx";
const KEY_GUESS = /^(id|code|number|no|ref|reference|key)$/i;

/** The step rail: done steps can be gone back to, later ones cannot be jumped to. */
const Steps = ({ step, reachable, onGo }) => (
  <ol aria-label="Steps" className="flex flex-wrap items-center gap-2">
    {STEPS.map((s, i) => {
      const done = s.n < step;
      const current = s.n === step;
      const canGo = s.n !== step && s.n <= reachable;
      return (
        <li key={s.n} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden="true" className={`h-px w-6 sm:w-10 ${done || current ? "bg-theme" : "bg-border-color"}`} />}
          <button
            type="button"
            disabled={!canGo}
            onClick={() => onGo(s.n)}
            aria-current={current ? "step" : undefined}
            className={`flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-sm ${current ? "bg-theme/10 font-semibold text-primary-text" : done ? "text-primary-text hover:bg-border-color" : "text-tertiary-text"}`}>
            <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${current || done ? "bg-theme text-white" : "bg-border-color text-secondary-text"}`}>
              {done ? <CheckIcon /> : s.n}
            </span>
            {s.label}
          </button>
        </li>
      );
    })}
  </ol>
);

/** The first rows of the file as a table. */
const Sample = ({ file }) => {
  const rows = file.sample.slice(0, 5);
  if (!rows.length) return <p className="text-sm text-secondary-text">The rows of this file have been cleared.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border-color">
      <table className="min-w-full text-left text-xs" aria-label="First rows">
        <thead className="bg-primary-bg">
          <tr>
            <th className="px-2 py-1.5 text-secondary-text">Row</th>
            {file.headers.map((h) => <th key={h} className="whitespace-nowrap px-2 py-1.5 text-secondary-text">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.row} className="border-t border-border-color">
              <td className="px-2 py-1.5 text-secondary-text">{r.row}</td>
              {file.headers.map((h) => <td key={h} className="max-w-[16rem] truncate whitespace-nowrap px-2 py-1.5 text-primary-text">{r.values[h]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** Step 1: which kind of record the file holds. */
const ChooseRecords = ({ entities, value, onChange, connection, mapped }) => (
  <ul aria-label="Kinds of record" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {entities.map((e) => {
      const notBuilt = connection && !(connection.importable ?? []).includes(e.entityType);
      const noRight = connection && !notBuilt && !(connection.writable ?? []).includes(e.entityType);
      const disabled = notBuilt || noRight;
      const selected = value === e.entityType;
      return (
        <li key={e.entityType}>
          <button
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(e.entityType)}
            className={`flex h-full w-full flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors ${selected ? "border-theme bg-theme/10 ring-2 ring-theme/30" : "border-border-color bg-primary-bg hover:border-theme"} ${disabled ? "cursor-not-allowed opacity-50 hover:border-border-color" : ""}`}>
            <span className="flex w-full items-center justify-between gap-2">
              <span className="text-sm font-semibold text-primary-text">{e.label}</span>
              {mapped.has(e.entityType) && !disabled && <span className="rounded-full bg-success-color/15 px-2 py-0.5 text-xs font-medium text-success-color">Mapping saved</span>}
            </span>
            <span className="text-xs text-secondary-text">
              {notBuilt ? "Not available yet." : noRight ? "You do not have the permission to add these." : ENTITY_DESCRIPTIONS[e.entityType] ?? e.keyHint}
            </span>
          </button>
        </li>
      );
    })}
  </ul>
);

/** Step 2: how to read the file, the file itself (or one uploaded before), and what importing may do to records already there. */
const ChooseFile = ({ connection, entityType, fileId, onFile, canUpload, canManage }) => {
  const { organisationId } = useOrganisation();
  const { showToast } = useToast();
  const mutation = useIntegrationMutation();
  const files = useIntegrationFiles(connection.id);
  const file = useIntegrationFile(fileId);
  const cfg = connection.config ?? {};
  const [options, setOptions] = useState({ hasHeader: cfg.hasHeader !== false, encoding: cfg.encoding ?? "utf-8", delimiter: cfg.delimiter ?? "," });
  const [uploaded, setUploaded] = useState(null); // { fileId, path, name, size, options } of the upload made on this screen
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef(null);
  const parsed = (files.data ?? []).filter((f) => f.status === "parsed");
  const isExcel = /\.xlsx$/i.test(file.data?.fileName ?? uploaded?.name ?? "");
  const stale = uploaded && uploaded.fileId === fileId && JSON.stringify(uploaded.options) !== JSON.stringify(options);

  const read = async (path, name, size) => {
    const result = await mutation.mutateAsync({ action: "registerFile", id: connection.id, body: { path, fileName: name, size, options } });
    setUploaded({ fileId: result.id, path, name, size, options });
    onFile(result.id);
    if (result.status === "failed") showToast({ type: "error", title: "The file could not be read", message: result.error });
  };
  const send = async (f) => {
    const problem = fileProblem(f);
    if (problem) return showToast({ type: "error", title: "Not uploaded", message: problem });
    setBusy(true);
    try {
      const { path } = await uploadFileToSupabase(f, "integration-files", organisationId, connection.id, "integration");
      await read(path, f.name, f.size);
    } catch (err) {
      showToast({ type: "error", title: "Not uploaded", message: describeApiError(err) });
    } finally {
      setBusy(false);
    }
  };
  const again = async () => {
    setBusy(true);
    try {
      await read(uploaded.path, uploaded.name, uploaded.size);
    } catch (err) {
      showToast({ type: "error", title: "Not read", message: describeApiError(err) });
    } finally {
      setBusy(false);
    }
  };
  const pick = (fl) => fl?.[0] && send(fl[0]);

  return (
    <div className="flex flex-col gap-4">
      <MenuCard title="How to read the file" subtitle="Excel workbooks are read from their first worksheet; only the heading setting applies to them.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col justify-end gap-1 pb-1.5">
            <Switch checked={options.hasHeader} onChange={(e) => setOptions({ ...options, hasHeader: e.target.checked })}>The first row holds column headings</Switch>
          </div>
          <ComboField label="Character set" value={options.encoding} onChange={(v) => setOptions({ ...options, encoding: v ?? "utf-8" })} options={ENCODINGS} required disabled={isExcel} />
          <ComboField label="Separator" value={options.delimiter} onChange={(v) => setOptions({ ...options, delimiter: v ?? "," })} options={DELIMITERS} required disabled={isExcel} />
        </div>
      </MenuCard>

      <MenuCard title="File" subtitle="Uploading reads the file and shows its first rows. Nothing is imported yet.">
        {canUpload && (
          <div
            role="button"
            tabIndex={0}
            aria-label="Upload a file"
            onClick={() => !busy && input.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !busy && input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); if (!busy) pick(e.dataTransfer.files); }}
            className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center text-sm ${drag ? "border-theme bg-theme/5" : "border-border-color"} ${busy ? "opacity-60" : ""}`}>
            <ProviderLogo mark="file" name="File" />
            <span className="font-medium text-primary-text">{busy ? "Uploading and reading…" : "Drop a file here or click to choose one"}</span>
            <span className="text-xs text-secondary-text">.csv, .txt or .xlsx, up to 25 MB</span>
            <input ref={input} type="file" accept={ACCEPT} className="hidden" data-testid="file-input" onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
          </div>
        )}
        {parsed.length > 0 && (
          <ComboField
            className="mt-3"
            label="Or use a file uploaded before"
            value={fileId}
            onChange={(v) => onFile(v)}
            options={parsed.map((f) => ({ value: f.id, label: f.fileName, hint: `${f.rowCount} rows · ${formatDateTime(f.uploadedAt)}` }))}
            clearable
          />
        )}
        {file.data && (
          <div className="mt-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <FileIcon name={file.data.fileName} className="h-8 w-8" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-primary-text">{file.data.fileName}</span>
                <span className="text-xs text-secondary-text">
                  {file.data.status === "failed" ? file.data.error : `${file.data.rowCount} rows · ${file.data.headers.length} columns${file.data.sheet ? ` · sheet ${file.data.sheet}` : ""}`}
                </span>
              </div>
              {stale && <CTAButton type="secondary" size="md" disabled={busy} onClick={again}>Read again with these settings</CTAButton>}
            </div>
            {file.data.status === "failed" ? <Callout tone="error" title="The file could not be read">{file.data.error}</Callout> : <Sample file={file.data} />}
          </div>
        )}
      </MenuCard>

      {entityType && <ImportSettingsCard connection={connection} entityType={entityType} readOnly={!canManage} />}
    </div>
  );
};

/** Asked when finishing changes a mapping that already has a version: every later version needs a reason. */
const ReasonDialog = ({ version, onCancel, onSave, busy }) => {
  const [reason, setReason] = useState("");
  return (
    <Dialog title="Why is the mapping changing?" onClose={onCancel}>
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); onSave(reason.trim()); }}>
        <p className="text-sm text-secondary-text">The mapping is saved as version {version + 1}. Every import says which version it used.</p>
        <TextAreaField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} required autoFocus />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onCancel}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={busy || reason.trim().length < 3}>Save and continue</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/**
 * Settings → Integrations → CSV or Excel file: a one-time import in three steps — the kind of record, the file and how to read it, then the columns
 * mapped to Fortress fields (kept as a reusable, versioned mapping). Uses the organisation's file connection, made on first use. Finishing saves the
 * mapping if it changed and starts a preview or an import; the run page shows what happened.
 */
const CsvImportWizard = () => {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { showToast } = useToast();
  const mutation = useIntegrationMutation();
  const connections = useIntegrationConnections();
  const entities = useIntegrationEntities();
  const fileConnections = (connections.data ?? []).filter((c) => c.provider?.key === "csv" && c.status !== "retired");
  const connId = params.get("connection") ?? fileConnections[0]?.id ?? null;
  const connection = useIntegrationConnection(connId);
  const entityType = params.get("entity");
  const fileId = params.get("file");
  const file = useIntegrationFile(fileId);
  const allMappings = useIntegrationMappings(connId);
  const catalogue = entities.data?.find((e) => e.entityType === entityType);
  const versions = (allMappings.data ?? []).filter((m) => m.entityType === entityType);
  const current = versions.find((v) => v.current) ?? null;
  const mapped = useMemo(() => new Set((allMappings.data ?? []).filter((m) => m.current).map((m) => m.entityType)), [allMappings.data]);
  const headers = file.data?.headers ?? [];
  const parsedOk = file.data?.status === "parsed";
  const reachable = !entityType ? 1 : !parsedOk ? 2 : 3;
  const step = Math.min(Number(params.get("step")) || 1, reachable);

  const [form, setForm] = useState(null);
  const [problems, setProblems] = useState([]);
  const [asking, setAsking] = useState(null); // the run kind waiting for a reason
  const [creating, setCreating] = useState(false);
  const formKey = `${entityType}|${current?.id ?? "none"}|${fileId ?? "none"}|${catalogue ? 1 : 0}|${file.data ? 1 : 0}|${allMappings.isSuccess ? 1 : 0}`;
  useEffect(() => {
    if (!catalogue || !allMappings.isSuccess || !file.data) return;
    const keyField = current?.keyField && headers.includes(current.keyField) ? current.keyField : headers.find((h) => KEY_GUESS.test(h.trim())) ?? headers[0] ?? null;
    const rows = mappingToRows(catalogue.fields, current, headers);
    // A first mapping: the record's own code usually is the column that identifies it.
    if (!current && keyField) {
      const i = catalogue.fields.findIndex((f, j) => f.required && !f.ref && /^(code|reference)$|Number$/.test(f.key) && !rows[j].source);
      if (i >= 0 && !rows.some((r) => r.source === keyField)) rows[i] = { ...rows[i], on: true, source: keyField };
    }
    setForm({ keyField, rows });
    setProblems([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey]);

  useBreadcrumbNames([{ path: "/Settings/Integrations/csv", label: "CSV or Excel file" }]);
  if (connections.isLoading || entities.isLoading || (connId && connection.isLoading) || (fileId && file.isLoading)) return <LoadingScreen />;
  const err = connections.error ?? entities.error ?? connection.error;
  if (err) return <div className="p-4"><ErrorNotice error={err} /></div>;

  const canManage = can("integrations.manage");
  const canRun = can("integrations.run");
  const conn = connection.data ?? null;
  const set = (patch, replace = false) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, String(v)) : next.delete(k)));
    setParams(next, { replace });
  };

  // The organisation's file connection is made the first time someone imports a file (file connections are in use at once).
  const ensureConnection = async () => {
    if (conn) return conn.id;
    setCreating(true);
    try {
      const made = await mutation.mutateAsync({ action: "create", body: { providerKey: "csv", name: "File imports", externalSystem: freeSystemCode(connections.data) } });
      return made.id;
    } finally {
      setCreating(false);
    }
  };
  const next1 = async () => {
    try {
      const id = await ensureConnection();
      set({ connection: id, step: 2 });
    } catch (e) {
      showToast({ type: "error", title: "Could not start the import", message: describeApiError(e) });
    }
  };

  const importable = !!conn && (conn.importable ?? []).includes(entityType);
  const writable = !!conn && (conn.writable ?? []).includes(entityType);
  const fields = catalogue?.fields ?? [];
  const missing = form ? fields.filter((f, i) => f.required && !rowHasSource(form.rows[i])).length : 0;
  const used = form ? form.rows.filter(rowHasSource).length : 0;
  const busy = mutation.isPending;

  const start = async (kind, reason) => {
    const body = rowsToFields(rowsInUse(form.rows), fields);
    try {
      if (mappingChanged(current, form.keyField, body)) {
        if (!canManage) throw new Error("Changing the mapping needs the permission to manage integrations");
        if (current && !reason) return setAsking(kind);
        await mutation.mutateAsync({ action: "saveMapping", id: conn.id, body: { entityType, keyField: form.keyField ?? "", fields: body, fileId, ...(reason ? { reason } : {}) } });
      }
      setAsking(null);
      const run = await mutation.mutateAsync({ action: "requestRun", id: conn.id, body: { entityType, kind, fileId } });
      navigate(`/Settings/Integrations/${conn.id}/runs/${run.id}`);
    } catch (e) {
      setAsking(null);
      if (e.details?.problems) setProblems(e.details.problems);
      else showToast({ type: "error", title: kind === "preview" ? "Preview not started" : "Import not started", message: describeApiError(e) });
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-border-color bg-secondary-bg p-4">
          <ProviderLogo mark="file" name="CSV or Excel file" />
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="text-lg font-semibold text-primary-text">Import a file</h1>
            <p className="text-xs text-secondary-text">
              {entityType ? `${ENTITY_LABELS[entityType] ?? entityType}${file.data ? ` from ${file.data.fileName}` : ""}` : "Bring records in from a CSV or Excel file."}
            </p>
          </div>
          <Steps step={step} reachable={reachable} onGo={(n) => set({ step: n })} />
        </div>

        {step === 1 && (
          <MenuCard title="What does the file hold?" subtitle="Choose the kind of record to import into.">
            {!conn && !canManage ? (
              <Callout tone="info">Nobody has imported a file here yet. Someone who manages integrations has to start the first import.</Callout>
            ) : (
              <ChooseRecords entities={entities.data ?? []} value={entityType} onChange={(v) => set({ entity: v, step: 1 }, true)} connection={conn} mapped={mapped} />
            )}
          </MenuCard>
        )}

        {step === 2 && conn && (
          <ChooseFile connection={conn} entityType={entityType} fileId={fileId} onFile={(id) => set({ file: id }, true)} canUpload={canRun} canManage={canManage} />
        )}

        {step === 3 && conn && catalogue && form && (
          <MenuCard title={`Map columns to ${catalogue.label.toLowerCase()}`} subtitle={current ? `Starting from the saved mapping (version ${current.version}). Open a row to change how its value is read.` : "Columns with matching names are chosen for you. Open a row to change how its value is read."}>
            <MappingStep
              fields={fields}
              columns={[...new Set([...headers, ...(current ? [current.keyField] : [])].filter(Boolean))]}
              sample={file.data?.sample ?? []}
              keyField={form.keyField}
              onKeyField={(v) => setForm({ ...form, keyField: v })}
              rows={form.rows}
              onRows={(rows) => setForm({ ...form, rows })}
              readOnly={!canManage}
              problems={problems}
            />
          </MenuCard>
        )}
      </div>

      <div className="sticky bottom-0 z-10 mt-auto border-t border-border-color bg-secondary-bg/95 px-4 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-secondary-text" role="status">
            {step === 1 && (entityType ? `${ENTITY_LABELS[entityType]} chosen` : "Choose what the file holds")}
            {step === 2 && (parsedOk ? `${file.data.rowCount} rows ready to map` : "Upload a file to continue")}
            {step === 3 && form && (missing > 0
              ? <span className="font-medium text-error-color">{missing === 1 ? "1 required field is not matched" : `${missing} required fields are not matched`}</span>
              : <span className="font-medium text-success-color">All required fields matched · {used} of {fields.length} fields used</span>)}
          </p>
          <div className="flex flex-wrap gap-2">
            {step === 1 ? (
              <CTAButton to="/Settings/Integrations" type="neutral" size="md">Cancel</CTAButton>
            ) : (
              <CTAButton type="neutral" size="md" onClick={() => set({ step: step - 1 })}>Back</CTAButton>
            )}
            {step === 1 && (
              <CTAButton type="main" size="md" disabled={!entityType || creating || (!conn && !canManage)} onClick={next1}>{creating ? "Starting…" : "Next"}</CTAButton>
            )}
            {step === 2 && <CTAButton type="main" size="md" disabled={!parsedOk} onClick={() => set({ step: 3 })}>Next</CTAButton>}
            {step === 3 && canRun && (
              <>
                <CTAButton type="secondary" size="md" disabled={busy || missing > 0 || !form?.keyField} onClick={() => start("preview")}>Preview</CTAButton>
                <CTAButton type="main" size="md" disabled={busy || missing > 0 || !form?.keyField || !importable || !writable} onClick={() => start("full")}>
                  {busy ? "Working…" : `Import ${file.data?.rowCount ?? ""} rows`.replace("  ", " ")}
                </CTAButton>
              </>
            )}
          </div>
        </div>
      </div>
      {asking && current && <ReasonDialog version={current.version} busy={busy} onCancel={() => setAsking(null)} onSave={(r) => start(asking, r)} />}
    </div>
  );
};

export default CsvImportWizard;
