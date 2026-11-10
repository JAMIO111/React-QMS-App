import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useToast } from "../../contexts/ToastProvider";
import { useImportTemplates, useIntegrationFiles, useIntegrationMutation, useIntegrationRuns } from "../../hooks/useIntegrations";
import { defaultTemplate } from "../../lib/importTemplates";
import { describeApiError } from "../../lib/api-client";
import { ENTITY_LABELS, RUN_KINDS, RUN_STATUS, apiMappingPath, runSummary, wizardPath } from "../../lib/integrations";
import { formatDateTime } from "../../lib/processControl";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { FormError } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";

export const RunStatusPill = ({ status }) => {
  const s = RUN_STATUS[status] ?? RUN_STATUS.queued;
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};

/** Ask for a preview (nothing written; allowed before activation) or a full / incremental import of one kind of record. */
const RunDialog = ({ connection, onClose }) => {
  const mutation = useIntegrationMutation();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const active = connection.status === "active";
  const isFile = connection.provider?.key === "csv";
  // An API connection reads only the kinds of record its settings say where to find (IN7).
  const isApi = connection.provider?.kind === "api";
  const configured = connection.config?.entities ?? {};
  const choices = isApi ? connection.runnable.filter((t) => t in configured) : connection.runnable;
  const [entityType, setEntityType] = useState(choices[0] ?? null);
  const [kind, setKind] = useState("preview");
  const files = useIntegrationFiles(connection.id, { enabled: isFile });
  const parsed = (files.data ?? []).filter((f) => f.status === "parsed");
  const [fileId, setFileId] = useState(null);
  const chosenFile = fileId ?? parsed[0]?.id ?? null;
  // A file is read with an import template for its kind of record (UI2c); the one used most recently is chosen.
  const templates = useImportTemplates(entityType, { enabled: (isFile || isApi) && !!entityType });
  const [templateId, setTemplateId] = useState(null);
  const chosenTemplate = (templates.data ?? []).some((t) => t.id === templateId) ? templateId : (defaultTemplate(templates.data) ?? templates.data?.[0])?.id ?? null;
  // A file always needs a template; an API connection needs one to write (a preview without one shows what arrives).
  const mapped = !isFile || !!chosenTemplate;
  const apiNeedsTemplate = isApi && !chosenTemplate;
  const incrementalSet = !isApi || !!configured[entityType]?.incremental;
  // Writing records needs an importer for that kind of record; a preview only needs the mapping.
  const importable = (connection.importable ?? []).includes(entityType);
  const writable = (connection.writable ?? connection.importable ?? []).includes(entityType);
  const kinds = [
    { value: "preview", label: "Preview" },
    { value: "full", label: isFile ? "Import" : "Full", disabled: !active || !importable || !writable || apiNeedsTemplate },
    ...(isFile ? [] : [{ value: "incremental", label: "Incremental", disabled: !active || !importable || !writable || apiNeedsTemplate || !incrementalSet }]),
  ];
  const runKind = kinds.some((k) => k.value === kind && !k.disabled) ? kind : "preview";
  const blocked = isFile && (!chosenFile || (!templates.isLoading && !mapped));
  const go = (e) => {
    e.preventDefault();
    if (!entityType) return;
    mutation.mutate(
      { action: "requestRun", id: connection.id, body: { entityType, kind: runKind, ...(isFile ? { fileId: chosenFile, templateId: chosenTemplate } : {}), ...(isApi && chosenTemplate ? { templateId: chosenTemplate } : {}) } },
      {
        onSuccess: (run) => {
          onClose();
          navigate(`/Settings/Integrations/${connection.id}/runs/${run.id}`);
        },
        onError: (err) => showToast({ type: "error", title: "Not started", message: describeApiError(err) }),
      },
    );
  };
  return (
    <Dialog title="Run an import" onClose={onClose}>
      <form noValidate onSubmit={go} className="flex flex-col gap-3">
        <ComboField label="Records" value={entityType} onChange={setEntityType} options={choices.map((t) => ({ value: t, label: ENTITY_LABELS[t] ?? t }))} required />
        {isApi && choices.length === 0 && <Callout tone="warning">Say in the connection's settings where the API gives each kind of record.</Callout>}
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-primary-text">What to do</span>
          <SlidingToggle ariaLabel="What to do" options={kinds} value={runKind} onChange={setKind} />
        </div>
        {isFile && (
          <ComboField
            label="File"
            value={chosenFile}
            onChange={setFileId}
            options={parsed.map((f) => ({ value: f.id, label: f.fileName, hint: `${f.rowCount} rows` }))}
            required
          />
        )}
        {isFile && parsed.length === 0 && <Callout tone="warning">Upload a file first.</Callout>}
        {(isFile || isApi) && (templates.data ?? []).length > 0 && (
          <ComboField
            label="Template"
            value={chosenTemplate}
            onChange={setTemplateId}
            options={(templates.data ?? []).map((t) => ({ value: t.id, label: t.name, hint: `version ${t.currentVersion}` }))}
            required
          />
        )}
        {isApi && entityType && !templates.isLoading && apiNeedsTemplate && (
          <Callout tone="info" action={<Link to={apiMappingPath(connection.id, entityType)} className="text-sm font-medium text-link-color hover:underline">Map fields</Link>}>
            There is no import template for {ENTITY_LABELS[entityType]?.toLowerCase() ?? "these records"} yet: a preview shows what the API sends, and importing needs a template that maps its fields.
          </Callout>
        )}
        {isFile && chosenFile && !templates.isLoading && !mapped && (
          <Callout tone="warning" action={<Link to={wizardPath(connection.id, { entity: entityType, file: chosenFile, step: 3 })} className="text-sm font-medium text-link-color hover:underline">Map columns</Link>}>
            Map the file's columns to {ENTITY_LABELS[entityType]?.toLowerCase() ?? "these records"} first.
          </Callout>
        )}
        <Callout tone="info">
          {runKind === "preview"
            ? "A preview reads the source and shows what would be created, updated or rejected. Nothing is written."
            : runKind === "full"
              ? "Reads everything from the start. Records already in Fortress and unchanged are left alone."
              : "Carries on from where the last import stopped."}
          {!active && ` ${isFile ? "A full import needs" : "Full and incremental imports need"} the connection to be active.`}
          {active && !importable && entityType && ` Writing ${ENTITY_LABELS[entityType]?.toLowerCase() ?? "these records"} to Fortress is not available yet: preview only.`}
          {active && importable && !writable && entityType && ` You can preview these, but writing them needs the permission to create and edit ${ENTITY_LABELS[entityType]?.toLowerCase() ?? "them"}.`}
          {isFile && runKind === "full" && " You approve this import yourself: the records are written as soon as it runs."}
        </Callout>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={mutation.isPending || !entityType || blocked} loading={mutation.isPending}>{mutation.isPending ? "Running…" : "Run"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** The connection page's Imports card: run an import and the latest runs with what each did. */
const ImportsCard = ({ connection, canRun }) => {
  const runs = useIntegrationRuns(connection.id);
  const [open, setOpen] = useState(false);
  const runnable = connection.runnable?.length > 0;
  const list = runs.data?.data ?? [];
  return (
    <MenuCard
      title="Imports"
      subtitle="Each import reads the source, stages every record, and applies only what is new or changed. Failed rows stay for a retry."
      action={canRun && runnable && connection.status !== "retired" && (
        <CTAButton buttonType="button" type="main" size="lg" onClick={() => setOpen(true)}>Run an import</CTAButton>
      )}>
      {!runnable && <Callout tone="info" className="mb-3">Nothing can be imported through this connection yet.</Callout>}
      {list.length === 0 ? (
        <p className="text-sm text-secondary-text">No imports yet.</p>
      ) : (
        <ul aria-label="Imports" className="flex flex-col divide-y divide-border-color">
          {list.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Link to={`/Settings/Integrations/${connection.id}/runs/${r.id}`} className="text-sm font-medium text-link-color hover:underline">
                  {RUN_KINDS[r.kind]} · {ENTITY_LABELS[r.entityType] ?? r.entityType}
                </Link>
                <span className="text-xs text-secondary-text">{runSummary(r)}</span>
              </div>
              <span className="text-xs text-secondary-text">{formatDateTime(r.requestedAt)}{r.requestedBy ? ` · ${r.requestedBy.name}` : ""}</span>
              <RunStatusPill status={r.status} />
            </li>
          ))}
        </ul>
      )}
      {open && <RunDialog connection={connection} onClose={() => setOpen(false)} />}
    </MenuCard>
  );
};

export default ImportsCard;
