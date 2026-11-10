import { useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../../contexts/ToastProvider";
import {
  useAttentionRows,
  useDecideMissing,
  useIgnoreRows,
  useImportTemplates,
  useIntegrationHealth,
  useIntegrationSettings,
  useMissingRecords,
  useSaveImportSettings,
} from "../../hooks/useIntegrations";
import { usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { ENTITY_LABELS, HEALTH_STATES, MISSING_OPTIONS, recordPath } from "../../lib/integrations";
import { formatDateTime } from "../../lib/processControl";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { TextAreaField } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";

const label = (t) => ENTITY_LABELS[t] ?? t;

/** One kind of record's schedule: manual or daily with a template, and what happens to records that disappear. Saved as chosen. */
const ScheduleRow = ({ connection, setting, canManage }) => {
  const save = useSaveImportSettings(connection.id);
  const templates = useImportTemplates(setting.entityType);
  const { showToast } = useToast();
  const send = (patch) => save.mutate({ entityType: setting.entityType, ...patch }, { onError: (e) => showToast({ type: "error", title: "Not saved", message: describeApiError(e) }) });
  const templateOptions = (templates.data ?? []).map((t) => ({ value: t.id, label: t.name, hint: `version ${t.currentVersion}` }));
  const templateId = setting.templateId ?? setting.template?.id ?? null;
  return (
    <li aria-label={`${label(setting.entityType)} schedule`} className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-primary-text">{label(setting.entityType)}</span>
        <SlidingToggle
          ariaLabel={`When ${label(setting.entityType).toLowerCase()} are imported`}
          value={setting.schedule}
          onChange={(v) => send(v === "daily" ? { schedule: "daily", templateId } : { schedule: "manual" })}
          options={[
            { value: "manual", label: "By hand", disabled: !canManage },
            { value: "daily", label: "Daily", disabled: !canManage || !templateId },
          ]}
        />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ComboField
          label="Import template"
          value={templateId}
          onChange={(v) => send({ templateId: v ?? null, ...(v ? {} : { schedule: "manual" }) })}
          options={templateOptions}
          disabled={!canManage}
          hint={templateOptions.length === 0 ? "Make a template for these records first" : undefined}
        />
        {setting.tracksMissing && (
          <ComboField
            label="When a record disappears from the source"
            value={setting.onMissing}
            onChange={(v) => send({ onMissing: v ?? "nothing" })}
            options={MISSING_OPTIONS.map((o) => ({ ...o, disabled: o.value === "deactivate" && !setting.canDeactivate }))}
            disabled={!canManage}
            hint="Checked after every full read. Making inactive waits for a person when more than 20% would go at once."
          />
        )}
      </div>
      {setting.schedule === "daily" && (
        <p className="text-xs text-secondary-text">
          Runs every night (about 04:00) as {setting.scheduledBy?.name ?? "the person who switched it on"}
          {setting.lastScheduledAt ? ` · last asked for ${formatDateTime(setting.lastScheduledAt)}` : ""}. Incremental when the connection says how, otherwise in full.
        </p>
      )}
      {setting.schedule === "daily" && setting.scheduleProblem && <Callout tone="warning" title="The last daily import did not start">{setting.scheduleProblem}</Callout>}
    </li>
  );
};

/** Schedules for an API connection's kinds of record (IN8). */
export const ScheduleCard = ({ connection }) => {
  const { can } = usePermissions();
  const settings = useIntegrationSettings(connection.id);
  const kinds = Object.keys(connection.config?.entities ?? {});
  const rows = (settings.data ?? []).filter((s) => kinds.includes(s.entityType));
  if (kinds.length === 0) return null;
  return (
    <MenuCard title="Schedule" subtitle="Import by hand, or every night with an import template. A daily import writes as whoever switched it on.">
      <ul aria-label="Schedules" className="flex flex-col divide-y divide-border-color">
        {rows.map((s) => <ScheduleRow key={s.entityType} connection={connection} setting={s} canManage={can("integrations.manage") && connection.status !== "retired"} />)}
      </ul>
    </MenuCard>
  );
};

const ReasonDialog = ({ title, prompt, confirm, onCancel, onConfirm }) => {
  const [reason, setReason] = useState("");
  const ok = reason.trim().length >= 3;
  return (
    <Dialog title={title} onClose={onCancel}>
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ok) onConfirm(reason.trim()); }}>
        <TextAreaField label={prompt} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} required maxLength={1000} />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onCancel}>Back</CTAButton>
          <CTAButton type="main" size="md" buttonType="submit" disabled={!ok}>{confirm}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Rows that were rejected or failed and not since imported: ignore them with a reason (or bring them back). The source is never edited here. */
export const AttentionCard = ({ connection, kinds }) => {
  const { can } = usePermissions();
  const [entityType, setEntityType] = useState(kinds[0] ?? null);
  const [view, setView] = useState("exclude");
  const [chosen, setChosen] = useState([]);
  const [asking, setAsking] = useState(false);
  const rows = useAttentionRows(connection.id, entityType, view);
  const change = useIgnoreRows(connection.id);
  const { showToast } = useToast();
  const canRun = can("integrations.run");
  const data = rows.data?.data ?? [];
  const toggle = (id) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const send = (action, reason) => {
    const rowIds = chosen;
    setChosen([]);
    change.mutate({ action, rowIds, reason }, {
      onSuccess: (r) => showToast({ type: "success", title: action === "ignore" ? `${r.changed} ignored` : `${r.changed} brought back` }),
      onError: (e) => showToast({ type: "error", title: "Not done", message: describeApiError(e) }),
    });
  };
  if (kinds.length === 0) return null;
  return (
    <MenuCard title="Rows that need a person" subtitle="Rejected or failed rows not since imported. Fix the source or the template and import again, or ignore a row with a reason.">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[12rem] flex-1">
            <ComboField label="Records" value={entityType} onChange={(v) => { setEntityType(v); setChosen([]); }} options={kinds.map((k) => ({ value: k, label: label(k) }))} />
          </div>
          <SlidingToggle ariaLabel="Which rows" value={view} onChange={(v) => { setView(v); setChosen([]); }} options={[{ value: "exclude", label: "Needing action" }, { value: "only", label: "Ignored" }]} />
        </div>
        {data.length === 0 ? (
          <p className="text-sm text-secondary-text">{view === "only" ? "No ignored rows." : "Nothing needs a person."}</p>
        ) : (
          <ul aria-label="Rows" className="flex flex-col divide-y divide-border-color">
            {data.map((r) => (
              <li key={r.id} className="flex items-start gap-3 py-2">
                {canRun && <input type="checkbox" aria-label={`Choose ${r.externalId ?? `row ${r.sourceRow ?? ""}`}`} className="mt-1" checked={chosen.includes(r.id)} onChange={() => toggle(r.id)} />}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
                  <span className="font-medium text-primary-text">{r.externalId ?? "No identifier"}{r.sourceRow ? ` · row ${r.sourceRow}` : ""} <span className="text-xs text-secondary-text">({r.status})</span></span>
                  {r.errors.map((e, i) => <span key={i} className="text-xs text-error-color">{e.message}</span>)}
                  {r.ignored && <span className="text-xs text-secondary-text">Ignored {formatDateTime(r.ignored.at)}{r.ignored.by ? ` by ${r.ignored.by.name}` : ""}: “{r.ignored.reason}”</span>}
                </div>
                <Link to={`/Settings/Integrations/${connection.id}/runs/${r.runId}`} className="text-xs text-link-color hover:underline">The import</Link>
              </li>
            ))}
          </ul>
        )}
        {canRun && chosen.length > 0 && (
          <div className="flex justify-end gap-2">
            {view === "exclude" ? (
              <CTAButton type="neutral" size="md" onClick={() => setAsking(true)}>Ignore {chosen.length}</CTAButton>
            ) : (
              <CTAButton type="neutral" size="md" onClick={() => send("restore")}>Bring back {chosen.length}</CTAButton>
            )}
          </div>
        )}
      </div>
      {asking && <ReasonDialog title="Ignore these rows" prompt="Why are they ignored?" confirm="Ignore" onCancel={() => setAsking(false)} onConfirm={(reason) => { setAsking(false); send("ignore", reason); }} />}
    </MenuCard>
  );
};

/** Records a full read no longer contained, waiting for a person: make inactive, or keep active with a reason. */
export const MissingCard = ({ connectionId, runId }) => {
  const list = useMissingRecords({ connectionId, runId, status: "open" });
  const decide = useDecideMissing();
  const { showToast } = useToast();
  const [chosen, setChosen] = useState([]);
  const [keeping, setKeeping] = useState(false);
  const data = list.data?.data ?? [];
  if (data.length === 0) return null;
  const decidable = data.filter((m) => m.canDecide);
  const send = (deactivate, note) => {
    const ids = chosen;
    setChosen([]);
    decide.mutate({ ids, deactivate, ...(note ? { note } : {}) }, {
      onSuccess: (r) => showToast({ type: "success", title: deactivate ? `${r.decided} made inactive` : `${r.decided} kept active` }),
      onError: (e) => showToast({ type: "error", title: "Not done", message: describeApiError(e) }),
    });
  };
  const held = data.some((m) => m.status === "held");
  return (
    <MenuCard title="Records no longer in the source" subtitle="A full read did not contain these. Nothing is deleted; decide whether each is made inactive.">
      <div className="flex flex-col gap-3">
        {held && <Callout tone="warning" title="Held for you">{data.find((m) => m.reason)?.reason ?? "Too many at once to make inactive without a person."}</Callout>}
        <ul aria-label="Records no longer in the source" className="flex flex-col divide-y divide-border-color">
          {data.map((m) => {
            const path = recordPath(m.entityType, m.record.id);
            return (
              <li key={m.id} className="flex items-center gap-3 py-2 text-sm">
                {m.canDecide && <input type="checkbox" aria-label={`Choose ${m.record.label ?? m.externalId}`} checked={chosen.includes(m.id)} onChange={() => setChosen((c) => (c.includes(m.id) ? c.filter((x) => x !== m.id) : [...c, m.id]))} />}
                <span className="min-w-0 flex-1">
                  {path && m.record.label ? <Link to={path} className="text-link-color hover:underline">{m.record.label}</Link> : (m.record.label ?? "A record you cannot see")}
                  <span className="text-xs text-secondary-text"> · {label(m.entityType)} · source id {m.externalId}{m.status === "held" ? " · held" : ""}</span>
                </span>
              </li>
            );
          })}
        </ul>
        {decidable.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            <CTAButton type="neutral" size="md" disabled={chosen.length === 0} onClick={() => setKeeping(true)}>Keep active</CTAButton>
            <CTAButton type="main" size="md" disabled={chosen.length === 0 || data.filter((m) => chosen.includes(m.id)).some((m) => !m.canDeactivate)} onClick={() => send(true)}>Make inactive</CTAButton>
          </div>
        )}
      </div>
      {keeping && <ReasonDialog title="Keep these records active" prompt="Why do they stay active?" confirm="Keep active" onCancel={() => setKeeping(false)} onConfirm={(note) => { setKeeping(false); send(false, note); }} />}
    </MenuCard>
  );
};

/** Every connection and kind of record at a glance (Settings → Integrations). */
export const HealthCard = () => {
  const health = useIntegrationHealth();
  const rows = health.data?.data ?? [];
  if (rows.length === 0) return null;
  return (
    <MenuCard title="Import health" subtitle="Schedules, the last import of each kind of record and what waits for a person.">
      <ul aria-label="Import health" className="flex flex-col divide-y divide-border-color">
        {rows.map((r) => {
          const s = HEALTH_STATES[r.state];
          const waits = [
            r.rowsNeedingAction ? `${r.rowsNeedingAction} row${r.rowsNeedingAction === 1 ? "" : "s"} to look at` : null,
            r.missingWaiting ? `${r.missingWaiting} no longer in the source` : null,
            r.conflictsOpen ? `${r.conflictsOpen} value${r.conflictsOpen === 1 ? "" : "s"} to review` : null,
            r.failedInARow > 1 ? `failed ${r.failedInARow} times in a row` : null,
            r.scheduleProblem,
          ].filter(Boolean);
          return (
            <li key={`${r.connectionId}-${r.entityType}`} aria-label={`${r.connectionName}: ${label(r.entityType)}`} className="flex flex-wrap items-center gap-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Link to={`/Settings/Integrations/${r.connectionId}`} className="text-sm font-medium text-link-color hover:underline">{r.connectionName} · {label(r.entityType)}</Link>
                <span className="text-xs text-secondary-text">
                  {r.schedule === "daily" ? "Daily" : "By hand"}
                  {r.lastRun ? ` · last import ${r.lastRun.status} ${formatDateTime(r.lastRun.finishedAt ?? r.lastRun.requestedAt)}` : " · not imported yet"}
                  {waits.length > 0 ? ` · ${waits.join(" · ")}` : ""}
                </span>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>
            </li>
          );
        })}
      </ul>
    </MenuCard>
  );
};
