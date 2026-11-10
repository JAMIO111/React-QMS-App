import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useToast } from "../../contexts/ToastProvider";
import { useImportTemplate, useImportTemplates, useIntegrationEntities, useTemplateMutation, useTemplateVersion, useTemplateVersions } from "../../hooks/useIntegrations";
import { useOrganisationDetails, usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { ENTITY_LABELS, WRITE_MODE_LABELS } from "../../lib/integrations";
import { describeStep, versionChanges } from "../../lib/importTemplates";
import { formatDateTime } from "../../lib/processControl";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import RowActionsMenu from "../ui/RowActionsMenu";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice, TextAreaField } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";

const templatePath = (id) => `/Settings/Integrations/Templates/${id}`;

/** A dialog asking for one piece of text (a name or a reason) before running a command. */
export const TextDialog = ({ title, label, initial = "", min = 1, multiline = false, note, action, busy, onCancel, onSave }) => {
  const [value, setValue] = useState(initial);
  const ok = value.trim().length >= min;
  const Input = multiline ? TextAreaField : Field;
  return (
    <Dialog title={title} onClose={onCancel}>
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ok) onSave(value.trim()); }}>
        {note && <p className="text-sm text-secondary-text">{note}</p>}
        <Input label={label} value={value} onChange={(e) => setValue(e.target.value)} required autoFocus maxLength={multiline ? 1000 : 120} {...(multiline ? { rows: 3 } : {})} />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onCancel}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={busy || !ok} loading={busy}>{action}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** The commands on one template, through dialogs: rename, duplicate, archive (reason), restore. Returns [menu items, dialog]. */
const useTemplateCommands = (template, { onDuplicated } = {}) => {
  const mutation = useTemplateMutation();
  const { showToast } = useToast();
  const [ask, setAsk] = useState(null);
  const run = async (action, body, done) => {
    try {
      const out = await mutation.mutateAsync({ action, id: template.id, body });
      setAsk(null);
      done?.(out);
    } catch (e) {
      showToast({ type: "error", title: "Not done", message: describeApiError(e) });
    }
  };
  const items = template
    ? [
        { label: "Rename", onSelect: () => setAsk("rename") },
        { label: "Duplicate", onSelect: () => setAsk("duplicate") },
        template.archived ? { label: "Bring back", onSelect: () => run("restore") } : { label: "Archive", tone: "danger", onSelect: () => setAsk("archive") },
      ]
    : [];
  const dialog =
    ask === "rename" ? (
      <TextDialog title="Rename the template" label="Name" initial={template.name} action="Rename" busy={mutation.isPending} onCancel={() => setAsk(null)} onSave={(name) => run("update", { name })} />
    ) : ask === "duplicate" ? (
      <TextDialog title="Duplicate the template" label="Name of the copy" initial={`Copy of ${template.name}`.slice(0, 120)} note="The copy starts at version 1 with the current version's content." action="Duplicate" busy={mutation.isPending} onCancel={() => setAsk(null)} onSave={(name) => run("duplicate", { name }, (out) => onDuplicated?.(out))} />
    ) : ask === "archive" ? (
      <TextDialog title="Archive the template" label="Why?" min={3} multiline note="It is hidden from the import screens and kept for the imports that used it. You can bring it back." action="Archive" busy={mutation.isPending} onCancel={() => setAsk(null)} onSave={(reason) => run("archive", { reason })} />
    ) : null;
  return [items, dialog];
};

const TemplateRow = ({ t, canManage }) => {
  const navigate = useNavigate();
  const [items, dialog] = useTemplateCommands(t, { onDuplicated: (out) => navigate(templatePath(out.id)) });
  return (
    <li className="flex flex-wrap items-center gap-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Link to={templatePath(t.id)} className="text-sm font-medium text-link-color hover:underline">{t.name}</Link>
        <span className="text-xs text-secondary-text">
          {ENTITY_LABELS[t.entityType] ?? t.entityType} · version {t.currentVersion} · {t.runCount === 1 ? "1 import" : `${t.runCount} imports`}
          {t.lastUsedAt ? ` · last used ${formatDateTime(t.lastUsedAt)}` : " · not used yet"}
        </span>
      </div>
      {t.archived && <span className="rounded-full bg-border-color px-2 py-0.5 text-xs text-secondary-text">Archived</span>}
      {canManage && <RowActionsMenu label={`Actions for ${t.name}`} items={items} />}
      {dialog}
    </li>
  );
};

/** Settings → Integrations → Templates: every import template by kind of record (archived ones on their own tab). */
export const TemplatesPage = () => {
  const { can } = usePermissions();
  const org = useOrganisationDetails();
  const entities = useIntegrationEntities();
  const [entity, setEntity] = useState(null);
  const [view, setView] = useState("live");
  const list = useImportTemplates(entity ?? undefined, { archived: view === "archived" ? "only" : "exclude" });
  useBreadcrumbNames([{ path: "/Settings/Integrations/Templates", label: "Templates" }]);
  if (!can("integrations.read")) return <div className="p-4"><Callout tone="info">Import templates are for Controller seat holders.</Callout></div>;
  if (org.data && !org.data.settings.advancedImports) {
    return (
      <div className="p-4">
        <Callout tone="info" title="Advanced imports are switched off">The template manager is shown when advanced imports are switched on in Settings → Integrations.</Callout>
      </div>
    );
  }
  const data = list.data ?? [];
  return (
    <div className="flex flex-col gap-4 p-4">
      <MenuCard title="Import templates" subtitle="How files' columns become Fortress fields, kept for the whole organisation. Every saved version stays; an import says which one it used.">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <ComboField className="w-64" label="Kind of record" value={entity} onChange={setEntity} options={(entities.data ?? []).map((e) => ({ value: e.entityType, label: e.label }))} placeholder="All kinds" />
          <SlidingToggle ariaLabel="Templates shown" value={view} onChange={setView} options={[{ value: "live", label: "In use" }, { value: "archived", label: "Archived" }]} />
        </div>
        {list.isLoading ? (
          <LoadingScreen />
        ) : list.error ? (
          <ErrorNotice error={list.error} />
        ) : data.length === 0 ? (
          <p className="text-sm text-secondary-text">{view === "archived" ? "No archived templates." : "No templates yet. Saving a mapping in the file import makes one."}</p>
        ) : (
          <ul aria-label="Templates" className="flex flex-col divide-y divide-border-color">
            {data.map((t) => <TemplateRow key={t.id} t={t} canManage={can("integrations.manage")} />)}
          </ul>
        )}
      </MenuCard>
    </div>
  );
};

/** One version's fields, as saved. */
const VersionFields = ({ version, labelOf }) => (
  <div className="flex flex-col gap-2 text-sm">
    <p className="text-secondary-text">
      Key column <span className="font-medium text-primary-text">{version.keyField}</span> · {WRITE_MODE_LABELS[version.settings.writeMode] ?? version.settings.writeMode}
      {version.settings.matchExisting ? " · matches records made by hand" : ""}
    </p>
    <ul className="flex flex-col divide-y divide-border-color rounded-lg border border-border-color">
      {version.fields.map((f) => (
        <li key={f.target} className="flex flex-col gap-0.5 px-3 py-2">
          <span className="font-medium text-primary-text">{labelOf(f.target)}</span>
          <span className="text-xs text-secondary-text">
            {f.formula ? <span className="font-mono">{f.formula}</span> : f.transform === "constant" ? `Always "${f.value}"` : f.transform === "concat" ? (f.sources ?? []).join(" + ") : `Column ${f.source ?? "—"}`}
            {(f.steps ?? []).map((s, i) => <span key={i}> → {describeStep(s)}</span>)}
          </span>
        </li>
      ))}
    </ul>
  </div>
);

/** A version in a dialog: what changed from the one before, the version itself, and "Bring back" for managers. */
const VersionDialog = ({ template, n, labelOf, canManage, onClose }) => {
  const v = useTemplateVersion(template.id, n);
  const before = useTemplateVersion(template.id, n > 1 ? n - 1 : null);
  const mutation = useTemplateMutation();
  const { showToast } = useToast();
  const [restoring, setRestoring] = useState(false);
  const bringBack = async (reason) => {
    try {
      await mutation.mutateAsync({ action: "restoreVersion", id: template.id, body: { version: n, reason } });
      showToast({ type: "success", title: "Brought back", message: `Version ${n} is now version ${template.currentVersion + 1}.` });
      onClose();
    } catch (e) {
      showToast({ type: "error", title: "Not brought back", message: describeApiError(e) });
    }
  };
  return (
    <Dialog title={`Version ${n} of ${template.name}`} onClose={onClose} width="max-w-2xl">
      {!v.data ? (
        <LoadingScreen />
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-secondary-text">
            {v.data.reason ? `“${v.data.reason}”` : "First version"} · {v.data.createdBy?.name ?? "Unknown"} · {formatDateTime(v.data.createdAt)} · {v.data.runCount === 1 ? "1 import" : `${v.data.runCount} imports`}
          </p>
          <section aria-label="What changed">
            <h3 className="mb-1 text-sm font-semibold text-primary-text">What changed</h3>
            <ul className="list-disc pl-5 text-sm text-primary-text">
              {versionChanges(n > 1 ? before.data : null, v.data, labelOf).map((c) => <li key={c}>{c}</li>)}
            </ul>
          </section>
          <VersionFields version={v.data} labelOf={labelOf} />
          {canManage && !v.data.current && !template.archived && (
            <div className="flex justify-end">
              <CTAButton type="secondary" size="md" onClick={() => setRestoring(true)}>Bring this version back</CTAButton>
            </div>
          )}
        </div>
      )}
      {restoring && (
        <TextDialog title={`Bring back version ${n}`} label="Why?" min={3} multiline note={`Its content is saved as version ${template.currentVersion + 1}. Nothing is lost.`} action="Bring back" busy={mutation.isPending} onCancel={() => setRestoring(false)} onSave={bringBack} />
      )}
    </Dialog>
  );
};

/** Settings → Integrations → Templates → one template: its current version, every version with its reason, and the commands on it. */
export const TemplatePage = () => {
  const { templateId } = useParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const template = useImportTemplate(templateId);
  const versions = useTemplateVersions(templateId);
  const entities = useIntegrationEntities();
  const [open, setOpen] = useState(null);
  const [items, dialog] = useTemplateCommands(template.data, { onDuplicated: (out) => navigate(templatePath(out.id)) });
  useBreadcrumbNames([{ path: "/Settings/Integrations/Templates", label: "Templates" }, template.data && { path: templatePath(templateId), label: template.data.name }].filter(Boolean));
  if (template.isLoading) return <LoadingScreen />;
  if (template.error) return <div className="p-4"><ErrorNotice error={template.error} /></div>;
  const t = template.data;
  const catalogue = entities.data?.find((e) => e.entityType === t.entityType);
  const labelOf = (k) => catalogue?.fields.find((f) => f.key === k)?.label ?? k;
  const canManage = t.canManage && can("integrations.manage");
  return (
    <div className="flex flex-col gap-4 p-4">
      <MenuCard
        title={t.name}
        subtitle={`${ENTITY_LABELS[t.entityType] ?? t.entityType} · version ${t.currentVersion} · ${t.runCount === 1 ? "1 import" : `${t.runCount} imports`}${t.lastUsedAt ? ` · last used ${formatDateTime(t.lastUsedAt)}` : ""}`}
        action={canManage && <RowActionsMenu label={`Actions for ${t.name}`} items={items} />}>
        {t.archived && <Callout tone="warning" title="Archived">{t.archived.reason} · {t.archived.by?.name ?? "Unknown"} · {formatDateTime(t.archived.at)}</Callout>}
        {t.description && <p className="mb-3 text-sm text-secondary-text">{t.description}</p>}
        {t.current && <VersionFields version={t.current} labelOf={labelOf} />}
      </MenuCard>
      <MenuCard title="Versions" subtitle="Newest first. A saved version never changes; open one to see what changed or to bring it back.">
        <ul aria-label="Versions" className="flex flex-col divide-y divide-border-color">
          {(versions.data ?? []).map((v) => (
            <li key={v.version} className="flex flex-wrap items-center gap-3 py-2">
              <button type="button" onClick={() => setOpen(v.version)} className="text-sm font-medium text-link-color hover:underline">Version {v.version}</button>
              {v.current && <span className="rounded-full bg-success-color/15 px-2 py-0.5 text-xs font-medium text-success-color">Current</span>}
              <span className="min-w-0 flex-1 truncate text-sm text-secondary-text">{v.reason ?? "First version"}</span>
              <span className="text-xs text-secondary-text">{v.createdBy?.name ?? "Unknown"} · {formatDateTime(v.createdAt)} · {v.fieldCount} fields · {v.runCount === 1 ? "1 import" : `${v.runCount} imports`}</span>
            </li>
          ))}
        </ul>
      </MenuCard>
      {open && <VersionDialog template={t} n={open} labelOf={labelOf} canManage={canManage} onClose={() => setOpen(null)} />}
      {dialog}
    </div>
  );
};

export default TemplatesPage;
