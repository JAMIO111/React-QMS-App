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
  useImportTemplate,
  useImportTemplates,
  useIntegrationMutation,
  useTemplateMutation,
  useTemplatePreview,
} from "../../hooks/useIntegrations";
import { useOrganisationDetails, usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import {
  FILE_DELIMITERS,
  FILE_ENCODINGS,
  ENTITY_DESCRIPTIONS,
  ENTITY_LABELS,
  WRITE_MODES,
  fileProblem,
  freeSystemCode,
  mappingToRows,
  rowHasSource,
  rowsInUse,
  rowsToFields,
} from "../../lib/integrations";
import { ADD_ONLY_KINDS, ADD_UPDATE_KINDS, defaultTemplate, stepProblem, templateChanged, templateSettings } from "../../lib/importTemplates";
import { formatDateTime } from "../../lib/processControl";
import { CheckIcon } from "@/components/icons";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import { FileIcon } from "../ui/FileDrop";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import Switch from "../ui/Switch";
import Field from "../ui/Field";
import { ErrorNotice, TextAreaField } from "../master-data/shared";
import MappingStep from "./MappingStep";
import ProviderLogo from "./ProviderLogo";
import CTAButton from "@/components/CTAButton";

const STEPS = [
  { n: 1, label: "Choose records" },
  { n: 2, label: "Upload a file" },
  { n: 3, label: "Map columns" },
];
const ACCEPT = ".csv,.txt,.xlsx";
export const KEY_GUESS = /^(id|code|number|no|ref|reference|key)$/i;

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
              {mapped.has(e.entityType) && !disabled && <span className="rounded-full bg-success-color/15 px-2 py-0.5 text-xs font-medium text-success-color">Template saved</span>}
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
const ChooseFile = ({ connection, fileId, onFile, canUpload, options, setOptions }) => {
  const { organisationId } = useOrganisation();
  const { showToast } = useToast();
  const mutation = useIntegrationMutation();
  const files = useIntegrationFiles(connection.id);
  const file = useIntegrationFile(fileId);
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
          <ComboField label="Character set" value={options.encoding} onChange={(v) => setOptions({ ...options, encoding: v ?? "auto" })} options={FILE_ENCODINGS} required disabled={isExcel} />
          <ComboField label="Separator" value={options.delimiter} onChange={(v) => setOptions({ ...options, delimiter: v ?? "auto" })} options={FILE_DELIMITERS} required disabled={isExcel} />
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
              {stale && <CTAButton type="secondary" size="md" disabled={busy} loading={busy} onClick={again}>Read again with these settings</CTAButton>}
            </div>
            {file.data.status === "failed" ? <Callout tone="error" title="The file could not be read">{file.data.error}</Callout> : <Sample file={file.data} />}
          </div>
        )}
      </MenuCard>
    </div>
  );
};

/**
 * Saving the mapping on screen: as the next version of the chosen template (a reason is needed: every import says which version it used) or as a new
 * template (a name). Only people who manage integrations save templates (T4).
 */
export const SaveTemplateDialog = ({ template, defaultName, onCancel, onSave, busy, action = "Save and continue" }) => {
  const [mode, setMode] = useState(template ? "version" : "new");
  const [reason, setReason] = useState("");
  const [name, setName] = useState(defaultName);
  const ok = mode === "version" ? reason.trim().length >= 3 : name.trim().length > 0;
  return (
    <Dialog title="Save the mapping as a template" onClose={onCancel}>
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ok) onSave(mode === "version" ? { mode, reason: reason.trim() } : { mode, name: name.trim() }); }}>
        {template && (
          <div className="flex flex-col gap-2" role="radiogroup" aria-label="How to save">
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="save-mode" checked={mode === "version"} onChange={() => setMode("version")} className="mt-1" />
              <span><span className="font-medium text-primary-text">Version {template.currentVersion + 1} of “{template.name}”</span><br /><span className="text-xs text-secondary-text">Imports that used earlier versions keep them.</span></span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="save-mode" checked={mode === "new"} onChange={() => setMode("new")} className="mt-1" />
              <span><span className="font-medium text-primary-text">A new template</span><br /><span className="text-xs text-secondary-text">“{template.name}” stays as it is.</span></span>
            </label>
          </div>
        )}
        {mode === "version" ? (
          <TextAreaField label="Why is it changing?" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} required autoFocus />
        ) : (
          <Field label="Template name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
        )}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onCancel}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={busy || !ok} loading={busy}>{action}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** What importing may do to records already in Fortress: kept on the template (NCs are always added, never matched). */
export const TemplateSettingsCard = ({ entityType, settings, onChange, readOnly }) => {
  const fixed = ADD_ONLY_KINDS.includes(entityType) || ADD_UPDATE_KINDS.includes(entityType);
  const why = {
    goods_receipt: "Deliveries are always added: one already imported is never changed by a later file.",
    po_receipt_total: "Totals are always added and updated: a higher total records a delivery of the increase.",
    nonconformance: "Non-conformances are always added as new drafts, never matched or updated.",
  };
  return (
    <MenuCard title="What importing may do" subtitle={fixed ? why[entityType] : "Saved with the template."}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ComboField label="Records" value={settings.writeMode} onChange={(v) => onChange({ ...settings, writeMode: v ?? "add_only" })} options={WRITE_MODES} required disabled={readOnly || fixed} />
        <div className="flex items-end pb-1.5">
          <Switch checked={!!settings.matchExisting} onChange={(e) => onChange({ ...settings, matchExisting: e.target.checked })} disabled={readOnly || fixed}>Match records made by hand, by code</Switch>
        </div>
      </div>
    </MenuCard>
  );
};

/**
 * Settings → Integrations → CSV or Excel file: a one-time import in three steps — the kind of record, the file and how to read it, then the columns
 * mapped to Fortress fields. The mapping is an organisation-wide import template (UI2c): step 3 starts from the template last used for the kind of
 * record (or another, or a new one); a change is saved as the template's next version (with a reason) or as a new template before importing, by
 * people who manage integrations. Every import is pinned to the template version it used. The examples, the steps' values and the column check all
 * come from the server (T3).
 */
const CsvImportWizard = () => {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { showToast } = useToast();
  const mutation = useIntegrationMutation();
  const templateMutation = useTemplateMutation();
  const connections = useIntegrationConnections();
  const entities = useIntegrationEntities();
  const org = useOrganisationDetails();
  const advanced = !!org.data?.settings?.advancedImports;
  const fileConnections = (connections.data ?? []).filter((c) => c.provider?.key === "csv" && c.status !== "retired");
  const connId = params.get("connection") ?? fileConnections[0]?.id ?? null;
  const connection = useIntegrationConnection(connId);
  const entityType = params.get("entity");
  const fileId = params.get("file");
  const file = useIntegrationFile(fileId);
  const allTemplates = useImportTemplates(undefined);
  const templates = (allTemplates.data ?? []).filter((t) => t.entityType === entityType);
  const fallback = defaultTemplate(templates);
  const templateParam = params.get("template");
  const templateId = templateParam === "new" ? null : templateParam ?? fallback?.id ?? null;
  const template = useImportTemplate(templateId);
  const version = templateId ? template.data?.current ?? null : null;
  const catalogue = entities.data?.find((e) => e.entityType === entityType);
  const mapped = useMemo(() => new Set((allTemplates.data ?? []).map((t) => t.entityType)), [allTemplates.data]);
  const headers = file.data?.headers ?? [];
  const parsedOk = file.data?.status === "parsed";
  const reachable = !entityType ? 1 : !parsedOk ? 2 : 3;
  const step = Math.min(Number(params.get("step")) || 1, reachable);

  const [options, setOptions] = useState({ hasHeader: true, encoding: "auto", delimiter: "auto" });
  const [form, setForm] = useState(null);
  const [problems, setProblems] = useState([]);
  const [saving, setSaving] = useState(null); // { kind: "preview" | "full" | null } while the save dialog is open
  const [creating, setCreating] = useState(false);
  const templateReady = !templateId || !!template.data;
  const formKey = `${entityType}|${templateId ?? "new"}|${version?.version ?? 0}|${fileId ?? "none"}|${catalogue ? 1 : 0}|${file.data ? 1 : 0}|${allTemplates.isSuccess ? 1 : 0}|${templateReady ? 1 : 0}`;
  useEffect(() => {
    if (!catalogue || !allTemplates.isSuccess || !file.data || !templateReady) return;
    const keyField = version?.keyField && headers.includes(version.keyField) ? version.keyField : headers.find((h) => KEY_GUESS.test(h.trim())) ?? headers[0] ?? null;
    const rows = mappingToRows(catalogue.fields, version, headers);
    // A first mapping: the record's own code usually is the column that identifies it.
    if (!version && keyField) {
      const i = catalogue.fields.findIndex((f, j) => f.required && !f.ref && /^(code|reference)$|Number$/.test(f.key) && !rows[j].source);
      if (i >= 0 && !rows.some((r) => r.source === keyField)) rows[i] = { ...rows[i], on: true, source: keyField };
    }
    setForm({ keyField, rows, settings: templateSettings(entityType, version?.settings) });
    setProblems([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey]);

  const fields = catalogue?.fields ?? [];
  const body = form ? rowsToFields(rowsInUse(form.rows), fields) : null;
  const preview = useTemplatePreview(form && parsedOk && step === 3 ? { entityType, fileId, keyField: form.keyField ?? "", fields: body } : null, { enabled: step === 3 });

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
  const missing = form ? fields.filter((f, i) => f.required && !rowHasSource(form.rows[i])).length : 0;
  const used = form ? form.rows.filter(rowHasSource).length : 0;
  const stepProblems = form ? form.rows.flatMap((r) => (rowHasSource(r) ? (r.steps ?? []).map(stepProblem).filter(Boolean) : [])) : [];
  const settings = form ? templateSettings(entityType, form.settings) : null;
  const changed = form ? templateChanged(version, { keyField: form.keyField, fields: body, settings }) : false;
  const blocking = preview.data?.columnCheck?.missing?.some((m) => m.blocking);
  const busy = mutation.isPending || templateMutation.isPending;
  const cannotSave = changed && !canManage;

  const templateBody = () => ({ keyField: form.keyField ?? "", fields: body, settings, sourceSettings: options, expectedColumns: headers });
  /** Save what is on screen as the template's next version or a new template; returns the template id. */
  const saveTemplate = async (choice) => {
    if (choice.mode === "version") {
      await templateMutation.mutateAsync({ action: "saveVersion", id: templateId, body: { ...templateBody(), reason: choice.reason } });
      return templateId;
    }
    const made = await templateMutation.mutateAsync({ action: "create", body: { entityType, name: choice.name, ...templateBody() } });
    return made.id;
  };
  const run = async (kind, id) => {
    const r = await mutation.mutateAsync({ action: "requestRun", id: conn.id, body: { entityType, kind, fileId, templateId: id } });
    navigate(`/Settings/Integrations/${conn.id}/runs/${r.id}`);
  };
  const start = async (kind) => {
    if (changed || !templateId) return setSaving({ kind });
    try {
      await run(kind, templateId);
    } catch (e) {
      showToast({ type: "error", title: kind === "preview" ? "Preview not started" : "Import not started", message: describeApiError(e) });
    }
  };
  const onSave = async (choice) => {
    const kind = saving?.kind;
    try {
      const id = await saveTemplate(choice);
      setSaving(null);
      set({ template: id }, true);
      if (kind) await run(kind, id);
      else showToast({ type: "success", title: "Template saved", message: choice.mode === "version" ? "Saved as a new version." : `Saved as “${choice.name}”.` });
    } catch (e) {
      setSaving(null);
      if (e.details?.problems) setProblems(e.details.problems);
      else showToast({ type: "error", title: "Not saved", message: describeApiError(e) });
    }
  };
  const templateOptions = [
    ...templates.map((t) => ({ value: t.id, label: t.name, hint: `version ${t.currentVersion}${t.lastUsedAt ? ` · last used ${formatDateTime(t.lastUsedAt)}` : ""}` })),
    { value: "new", label: "Start a new mapping", hint: "Columns with matching names are chosen for you" },
  ];
  const disabledReason = missing > 0 ? null : !form?.keyField ? "Choose the column that identifies each record" : blocking ? "Columns the mapping needs are not in this file" : stepProblems[0] ?? (cannotSave ? "Ask someone who manages integrations to save these changes" : null);

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
              <ChooseRecords entities={entities.data ?? []} value={entityType} onChange={(v) => set({ entity: v, template: null, step: 1 }, true)} connection={conn} mapped={mapped} />
            )}
          </MenuCard>
        )}

        {step === 2 && conn && (
          <ChooseFile connection={conn} fileId={fileId} onFile={(id) => set({ file: id }, true)} canUpload={canRun} options={options} setOptions={setOptions} />
        )}

        {step === 3 && conn && catalogue && form && (
          <>
            <MenuCard
              title="Template"
              subtitle="A template remembers how a file's columns become Fortress fields, for everyone in the organisation."
              action={canManage && <CTAButton type="secondary" size="md" disabled={busy || !changed} onClick={() => setSaving({ kind: null })}>{templateId ? "Save a new version" : "Save as template"}</CTAButton>}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ComboField label="Start from" value={templateId ?? "new"} onChange={(v) => set({ template: v ?? "new" }, true)} options={templateOptions} required />
                <div className="flex items-end pb-1.5 text-sm text-secondary-text" role="status">
                  {templateId && version
                    ? changed ? <span className="font-medium text-warning-color">Changed from version {version.version}{canManage ? ": save it before importing" : ""}</span> : `Version ${version.version}, unchanged`
                    : templateId ? "Loading…" : "Not saved yet"}
                </div>
              </div>
            </MenuCard>
            <TemplateSettingsCard entityType={entityType} settings={form.settings} onChange={(s) => setForm({ ...form, settings: s })} readOnly={!canRun} />
            <MenuCard title={`Map columns to ${catalogue.label.toLowerCase()}`} subtitle="Open a row to change how its value is read. The examples are worked out by Fortress exactly as the import will.">
              <MappingStep
                fields={fields}
                columns={[...new Set([...headers, ...(version ? [version.keyField] : [])].filter(Boolean))]}
                sample={file.data?.sample ?? []}
                preview={preview.data}
                previewing={preview.isFetching}
                keyField={form.keyField}
                onKeyField={(v) => setForm({ ...form, keyField: v })}
                rows={form.rows}
                onRows={(rows) => setForm({ ...form, rows })}
                readOnly={!canRun}
                advanced={advanced}
                problems={problems}
                updates={!ADD_ONLY_KINDS.includes(entityType) && !ADD_UPDATE_KINDS.includes(entityType) && (form.settings?.writeMode ?? "add_only") !== "add_only"}
              />
            </MenuCard>
          </>
        )}
      </div>

      <div className="sticky -bottom-5 z-10 -mx-5 -mb-5 mt-auto border-t border-border-color bg-secondary-bg/95 px-9 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-secondary-text" role="status">
            {step === 1 && (entityType ? `${ENTITY_LABELS[entityType]} chosen` : "Choose what the file holds")}
            {step === 2 && (parsedOk ? `${file.data.rowCount} rows ready to map` : "Upload a file to continue")}
            {step === 3 && form && (missing > 0
              ? <span className="font-medium text-error-color">{missing === 1 ? "1 required field is not matched" : `${missing} required fields are not matched`}</span>
              : disabledReason
                ? <span className="font-medium text-error-color">{disabledReason}</span>
                : <span className="font-medium text-success-color">All required fields matched · {used} of {fields.length} fields used</span>)}
          </p>
          <div className="flex flex-wrap gap-2">
            {step === 1 ? (
              <CTAButton to="/Settings/Integrations" type="neutral" size="md">Cancel</CTAButton>
            ) : (
              <CTAButton type="neutral" size="md" onClick={() => set({ step: step - 1 })}>Back</CTAButton>
            )}
            {step === 1 && (
              <CTAButton type="main" size="md" disabled={!entityType || creating || (!conn && !canManage)} loading={creating} onClick={next1}>{creating ? "Starting…" : "Next"}</CTAButton>
            )}
            {step === 2 && <CTAButton type="main" size="md" disabled={!parsedOk} onClick={() => set({ step: 3 })}>Next</CTAButton>}
            {step === 3 && canRun && (
              <>
                <CTAButton type="secondary" size="md" disabled={busy || missing > 0 || !!disabledReason} loading={busy} onClick={() => start("preview")}>Preview</CTAButton>
                <CTAButton type="main" size="md" disabled={busy || missing > 0 || !!disabledReason || !importable || !writable} loading={busy} onClick={() => start("full")}>
                  {busy ? "Working…" : `Import ${file.data?.rowCount ?? ""} rows`.replace("  ", " ")}
                </CTAButton>
              </>
            )}
          </div>
        </div>
      </div>
      {saving && (
        <SaveTemplateDialog
          template={templateId ? template.data : null}
          defaultName={`${ENTITY_LABELS[entityType] ?? entityType} from ${file.data?.fileName ?? "a file"}`}
          busy={busy}
          action={saving.kind ? (saving.kind === "preview" ? "Save and preview" : "Save and import") : "Save"}
          onCancel={() => setSaving(null)}
          onSave={onSave}
        />
      )}
    </div>
  );
};

export default CsvImportWizard;
