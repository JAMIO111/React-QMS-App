import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useToast } from "../../contexts/ToastProvider";
import {
  useApiSampleQuery,
  useImportTemplate,
  useImportTemplates,
  useIntegrationConnection,
  useIntegrationEntities,
  useIntegrationRuns,
  useIntegrationMutation,
  useTemplateMutation,
  useTemplatePreview,
} from "../../hooks/useIntegrations";
import { useOrganisationDetails, usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { DB_ENGINES, ENTITY_LABELS, describeRecordSource, mappingToRows, rowHasSource, rowsInUse, rowsToFields } from "../../lib/integrations";
import { ADD_ONLY_KINDS, ADD_UPDATE_KINDS, connectionTemplate, stepProblem, templateChanged, templateSettings } from "../../lib/importTemplates";
import { formatDateTime } from "../../lib/processControl";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import { ErrorNotice } from "../master-data/shared";
import { KEY_GUESS, SaveTemplateDialog, TemplateSettingsCard } from "./CsvImportWizard";
import MappingStep from "./MappingStep";
import { Failed, useAsk, Waiting } from "./database/agentAsk";
import ProviderLogo from "./ProviderLogo";
import CTAButton from "@/components/CTAButton";

/** What the page calls the source: an API's fields, or a database table's columns (AG3). */
const WORDS = {
  api: { what: "field the API sends", fields: "fields", reading: "Reading the first page from the API…", unread: "The API could not be read", none: "The API sent no records", start: "Read what the API sends to start mapping", missing: "Fields the mapping needs are not in what the API sends", choose: "Choose which field the API sends becomes each Fortress field." },
  database: { what: "column of the table", fields: "columns", reading: "Reading the sample…", unread: "The sample could not be read", none: "The table sent no rows", start: "Ask the connector agent for a sample to start mapping", missing: "Columns the mapping needs are not in the table", choose: "Choose which column of the table becomes each Fortress field." },
};

/**
 * A database connection (AG3) is mapped the same way from a sample the connector agent sends (the first rows of the table chosen for that kind of
 * record, cut to its columns): Fortress cannot read the database itself, so the page asks the agent for the sample when there is none yet.
 *
 * Map an API connection's fields to Fortress fields (after IN7): the API's first page for the chosen kind of record is read once (nothing is stored)
 * and its columns — nested fields with dots — feed the same mapping editor as the file wizard. The examples, the value after each step and the
 * column check come from the server, which reads the API again exactly as an import would. The mapping is an organisation-wide import template:
 * a change is saved as the template's next version (with a reason) or as a new template, by people who manage integrations, before previewing or
 * importing. A preview may run before the connection is active; an import needs it active.
 */
const ApiMappingPage = () => {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { showToast } = useToast();
  const mutation = useIntegrationMutation();
  const templateMutation = useTemplateMutation();
  const connection = useIntegrationConnection(id);
  const entities = useIntegrationEntities();
  const org = useOrganisationDetails();
  const advanced = !!org.data?.settings?.advancedImports;
  const conn = connection.data ?? null;
  const isDb = conn?.provider?.key === "sql_agent";
  const W = WORDS[isDb ? "database" : "api"];
  const kinds = isDb ? (conn?.recordSources ?? []).map((x) => x.entityType) : Object.keys(conn?.config?.entities ?? {});
  const recordSource = isDb ? (conn?.recordSources ?? []).find((x) => x.entityType === (kinds.includes(params.get("entity")) ? params.get("entity") : kinds[0]))?.source : null;
  const entityParam = params.get("entity");
  const entityType = kinds.includes(entityParam) ? entityParam : kinds[0] ?? null;
  const catalogue = entities.data?.find((e) => e.entityType === entityType);
  const sample = useApiSampleQuery(["rest_api", "sql_agent"].includes(conn?.provider?.key) ? id : null, entityType);
  // A database connection's sample is asked of the agent; once it has answered, the sample is read again.
  const askSample = useAsk(id);
  const askedStatus = askSample.job?.status;
  useEffect(() => {
    if (askedStatus === "completed") sample.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askedStatus]);
  const needsSample = isDb && sample.error?.code === "agent_sample_needed";
  const askForSample = () => recordSource && askSample.ask("preview", { schema: recordSource.schema, object: recordSource.object, limit: 20 });
  const readAgain = () => (isDb ? askForSample() : sample.refetch());
  const allTemplates = useImportTemplates(undefined);
  const templates = (allTemplates.data ?? []).filter((t) => t.entityType === entityType);
  const runs = useIntegrationRuns(id);
  // Start from what this connection last imported with; never from a template made for another source (e.g. a file's columns).
  const fallback = connectionTemplate(runs.data?.data, entityType, templates);
  const templateParam = params.get("template");
  const templateId = templateParam === "new" ? null : templateParam ?? fallback?.id ?? null;
  const template = useImportTemplate(templateId);
  const version = templateId ? template.data?.current ?? null : null;
  const headers = useMemo(() => sample.data?.columns ?? [], [sample.data]);
  const sampleRows = useMemo(() => (sample.data?.rows ?? []).map((r) => ({ row: r.r, values: r.v })), [sample.data]);

  const [form, setForm] = useState(null);
  const [problems, setProblems] = useState([]);
  const [saving, setSaving] = useState(null); // { kind } while the save dialog is open
  const templateReady = (!templateId || !!template.data) && !runs.isLoading;
  const formKey = `${entityType}|${templateId ?? "new"}|${version?.version ?? 0}|${catalogue ? 1 : 0}|${sample.data ? headers.join("\u0001") : "-"}|${allTemplates.isSuccess ? 1 : 0}|${templateReady ? 1 : 0}`;
  useEffect(() => {
    if (!catalogue || !allTemplates.isSuccess || !sample.data || !templateReady) return;
    // Fields can only be mapped from records the API sends.
    if (headers.length === 0) {
      setForm(null);
      return;
    }
    const keyField = version?.keyField ?? headers.find((h) => KEY_GUESS.test(h.trim())) ?? headers[0] ?? null;
    const rows = mappingToRows(catalogue.fields, version, headers);
    // A first mapping: the record's own code usually is the field that identifies it.
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
  // The preview reads the API again on the server, so it waits a little longer than the file wizard's after each change.
  const preview = useTemplatePreview(form && sample.data && headers.length ? { entityType, connectionId: id, keyField: form.keyField ?? "", fields: body } : null, { delay: 800 });

  useBreadcrumbNames(conn ? [{ path: `/Settings/Integrations/${id}`, label: conn.name }, { path: `/Settings/Integrations/${id}/map`, label: "Map fields" }] : []);
  if (connection.isLoading || entities.isLoading) return <LoadingScreen />;
  const err = connection.error ?? entities.error;
  if (err) return <div className="p-4"><ErrorNotice error={err} /></div>;
  if (!conn) return null;
  if (conn.provider?.key !== "rest_api" && !isDb) {
    return <div className="p-4"><Callout tone="info">Only API and database connections are mapped here. Files are mapped in the file import wizard.</Callout></div>;
  }

  const canManage = can("integrations.manage");
  const canRun = can("integrations.run");
  const set = (patch, replace = true) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, String(v)) : next.delete(k)));
    setParams(next, { replace });
  };
  const active = conn.status === "active";
  const importable = (conn.importable ?? []).includes(entityType);
  const writable = (conn.writable ?? []).includes(entityType);
  const missing = form ? fields.filter((f, i) => f.required && !rowHasSource(form.rows[i])).length : 0;
  const used = form ? form.rows.filter(rowHasSource).length : 0;
  const stepProblems = form ? form.rows.flatMap((r) => (rowHasSource(r) ? (r.steps ?? []).map(stepProblem).filter(Boolean) : [])) : [];
  const settings = form ? templateSettings(entityType, form.settings) : null;
  const changed = form ? templateChanged(version, { keyField: form.keyField, fields: body, settings }) : false;
  const blocking = preview.data?.columnCheck?.missing?.some((m) => m.blocking);
  const busy = mutation.isPending || templateMutation.isPending;
  const cannotSave = changed && !canManage;
  const disabledReason =
    missing > 0 ? null
      : !form?.keyField ? "Choose the field that identifies each record"
        : blocking ? W.missing
          : stepProblems[0] ?? (cannotSave ? "Ask someone who manages integrations to save these changes" : null);
  const importReason = !active ? "Activate the connection to import (a preview works before that)" : !importable || !writable ? "You may not import these records" : null;

  const templateBody = () => ({ keyField: form.keyField ?? "", fields: body, settings, expectedColumns: headers });
  const saveTemplate = async (choice) => {
    if (choice.mode === "version") {
      await templateMutation.mutateAsync({ action: "saveVersion", id: templateId, body: { ...templateBody(), reason: choice.reason } });
      return templateId;
    }
    const made = await templateMutation.mutateAsync({ action: "create", body: { entityType, name: choice.name, ...templateBody() } });
    return made.id;
  };
  const run = async (kind, tid) => {
    const r = await mutation.mutateAsync({ action: "requestRun", id: conn.id, body: { entityType, kind, templateId: tid } });
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
      const tid = await saveTemplate(choice);
      setSaving(null);
      set({ template: tid });
      if (kind) await run(kind, tid);
      else showToast({ type: "success", title: "Template saved", message: choice.mode === "version" ? "Saved as a new version." : `Saved as “${choice.name}”.` });
    } catch (e) {
      setSaving(null);
      if (e.details?.problems) setProblems(e.details.problems);
      else showToast({ type: "error", title: "Not saved", message: describeApiError(e) });
    }
  };
  const templateOptions = [
    ...templates.map((t) => ({ value: t.id, label: t.name, hint: `version ${t.currentVersion}${t.lastUsedAt ? ` · last used ${formatDateTime(t.lastUsedAt)}` : ""}` })),
    { value: "new", label: "Start a new mapping", hint: "Fields with matching names are chosen for you" },
  ];

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-border-color bg-secondary-bg p-4">
          {isDb ? <ProviderLogo mark={conn.config?.engine === "postgres" ? "postgresql" : "database"} name={DB_ENGINES[conn.config?.engine] ?? "Database"} /> : <ProviderLogo mark="api" name="REST API" />}
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="text-lg font-semibold text-primary-text">Map fields from {conn.name}</h1>
            <p className="text-xs text-secondary-text">{W.choose} Nothing is imported until you preview or import.</p>
          </div>
        </div>

        {kinds.length === 0 ? (
          <Callout tone="info" title="No records set up yet">
            {isDb
              ? "Choose on the connection's page which table each kind of record is read from, then map its columns here."
              : "Say in the connection's settings where the API gives each kind of record, then map its fields here."}
          </Callout>
        ) : (
          <>
            <MenuCard
              title="Records and template"
              subtitle="A template remembers how the API's fields become Fortress fields, for everyone in the organisation."
              action={canManage && form && <CTAButton type="secondary" size="md" disabled={busy || !changed} onClick={() => setSaving({ kind: null })}>{templateId ? "Save a new version" : "Save as template"}</CTAButton>}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <ComboField label="Records" value={entityType} onChange={(v) => v && set({ entity: v, template: null })} options={kinds.map((k) => ({ value: k, label: ENTITY_LABELS[k] ?? k, hint: isDb ? describeRecordSource(conn.recordSources.find((x) => x.entityType === k).source) : conn.config.entities[k]?.path }))} required />
                <ComboField label="Start from" value={templateId ?? "new"} onChange={(v) => set({ template: v ?? "new" })} options={templateOptions} required />
                <div className="flex items-end pb-1.5 text-sm text-secondary-text" role="status">
                  {templateId && version
                    ? changed ? <span className="font-medium text-warning-color">Changed from version {version.version}{canManage ? ": save it before importing" : ""}</span> : `Version ${version.version}, unchanged`
                    : templateId ? "Loading…" : "Not saved yet"}
                </div>
              </div>
            </MenuCard>

            {sample.isLoading && <p className="text-sm text-secondary-text" role="status">{W.reading}</p>}
            {needsSample && (
              <Callout tone="info" title="Ask the connector agent for a sample"
                action={<CTAButton type="main" size="md" onClick={askForSample} loading={askSample.busy} loadingText="Asking the agent…">Ask for a sample</CTAButton>}>
                Fortress does not read the database itself: the agent sends the first rows of {recordSource ? `${recordSource.schema}.${recordSource.object}` : "the table"}, and the columns are mapped from them.
              </Callout>
            )}
            {isDb && askSample.busy && <Waiting job={askSample.job} />}
            {isDb && askSample.job?.status === "failed" && <Failed job={askSample.job} />}
            {sample.error && !needsSample && (
              <Callout tone="error" title={W.unread} action={<CTAButton type="neutral" size="md" onClick={() => sample.refetch()} loading={sample.isFetching}>Try again</CTAButton>}>
                {describeApiError(sample.error)}
              </Callout>
            )}
            {sample.data && headers.length === 0 && (
              <Callout tone="warning" title={W.none} action={<CTAButton type="neutral" size="md" onClick={readAgain} loading={sample.isFetching || askSample.busy}>Read again</CTAButton>}>
                {isDb
                  ? "Columns can only be mapped from rows the table holds. Check the table chosen and its filters on the connection's page."
                  : "Fields can only be mapped from records the API sends. Check the path and where the list is in the answer in the connection's settings."}
              </Callout>
            )}

            {sample.data && headers.length > 0 && catalogue && form && (
              <>
                <TemplateSettingsCard entityType={entityType} settings={form.settings} onChange={(s) => setForm({ ...form, settings: s })} readOnly={!canRun} />
                <MenuCard
                  title={`Map fields to ${catalogue.label.toLowerCase()}`}
                  subtitle={isDb
                    ? `${headers.length} columns in the first ${sampleRows.length} rows the agent sent. The examples are worked out by Fortress exactly as the import will.`
                    : `${headers.length} fields in the first ${sampleRows.length} records. Nested fields have dots, e.g. dimensions.width. The examples are worked out by Fortress exactly as the import will.`}
                  action={<CTAButton type="neutral" size="md" onClick={readAgain} loading={sample.isFetching || askSample.busy}>Read again</CTAButton>}>
                  <MappingStep
                    fields={fields}
                    columns={[...new Set([...headers, ...(version ? [version.keyField] : [])].filter(Boolean))]}
                    sample={sampleRows}
                    preview={preview.data}
                    previewing={preview.isFetching}
                    keyField={form.keyField}
                    onKeyField={(v) => setForm({ ...form, keyField: v })}
                    rows={form.rows}
                    onRows={(rows) => setForm({ ...form, rows })}
                    readOnly={!canRun}
                    advanced={advanced}
                    problems={problems}
                    source={isDb ? "database" : "api"}
                    updates={!ADD_ONLY_KINDS.includes(entityType) && !ADD_UPDATE_KINDS.includes(entityType) && (form.settings?.writeMode ?? "add_only") !== "add_only"}
                  />
                </MenuCard>
              </>
            )}
          </>
        )}
      </div>

      <div className="sticky -bottom-5 z-10 -mx-5 -mb-5 mt-auto border-t border-border-color bg-secondary-bg/95 px-9 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-secondary-text" role="status">
            {!form ? W.start
              : missing > 0 ? <span className="font-medium text-error-color">{missing === 1 ? "1 required field is not matched" : `${missing} required fields are not matched`}</span>
                : disabledReason ? <span className="font-medium text-error-color">{disabledReason}</span>
                  : <span className="font-medium text-success-color">All required fields matched · {used} of {fields.length} fields used{importReason ? ` · ${importReason}` : ""}</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            <CTAButton to={`/Settings/Integrations/${id}`} type="neutral" size="md">Back to the connection</CTAButton>
            {form && canRun && (
              <>
                <CTAButton type="secondary" size="md" disabled={busy || missing > 0 || !!disabledReason} loading={busy} onClick={() => start("preview")}>Preview</CTAButton>
                <CTAButton type="main" size="md" disabled={busy || missing > 0 || !!disabledReason || !!importReason} loading={busy} onClick={() => start("full")}>
                  {busy ? "Working…" : "Import"}
                </CTAButton>
              </>
            )}
          </div>
        </div>
      </div>
      {saving && (
        <SaveTemplateDialog
          template={templateId ? template.data : null}
          defaultName={`${ENTITY_LABELS[entityType] ?? entityType} from ${conn.name}`}
          busy={busy}
          action={saving.kind ? (saving.kind === "preview" ? "Save and preview" : "Save and import") : "Save"}
          onCancel={() => setSaving(null)}
          onSave={onSave}
        />
      )}
    </div>
  );
};

export default ApiMappingPage;
