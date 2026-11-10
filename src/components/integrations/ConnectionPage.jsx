import { useState } from "react";
import { useParams } from "react-router-dom";
import { useToast } from "../../contexts/ToastProvider";
import { useIntegrationConnection, useIntegrationMutation, useIntegrationProviders } from "../../hooks/useIntegrations";
import { usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { CREDENTIAL_KINDS, EVENT_LABELS, credentialKindFor } from "../../lib/integrations";
import { formatDateTime } from "../../lib/processControl";
import { StatusPill } from "../Settings/SettingsIntegrations";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import RowActionsMenu from "../ui/RowActionsMenu";

import { ErrorNotice, FormError, TextAreaField } from "../master-data/shared";
import ConnectionForm from "./ConnectionForm";
import ApiSampleCard from "./ApiSampleCard";
import { AttentionCard, MissingCard, ScheduleCard } from "./KeepHealthy";
import FilesCard from "./FilesCard";
import ImportsCard from "./ImportsCard";
import ReconciliationCard from "./ReconciliationCard";
import CTAButton from "@/components/CTAButton";

/** Paste a credential once. It is sent in one request, stored encrypted and never shown again. */
const CredentialDialog = ({ connection, kind, onClose }) => {
  const mutation = useIntegrationMutation();
  const { showToast } = useToast();
  const [secret, setSecret] = useState("");
  const [user, setUser] = useState("");
  const value = kind === "basic" ? `${user}:${secret}` : secret;
  const ok = secret.trim() && (kind !== "basic" || user.trim());
  const save = (e) => {
    e.preventDefault();
    if (!ok) return;
    mutation.mutate({ action: "setCredential", id: connection.id, body: { kind, secret: value } }, { onSuccess: () => onClose(), onError: (err) => showToast({ type: "error", title: "Not stored", message: describeApiError(err) }) });
  };
  return (
    <Dialog title={connection.credential ? "Replace the credential" : "Store a credential"} onClose={onClose}>
      <form noValidate onSubmit={save} autoComplete="off" className="flex flex-col gap-3">
        <Callout tone="info">It is stored encrypted and cannot be read back. To change it later, replace it.</Callout>
        {kind === "basic" && <Field label="User name" value={user} onChange={(e) => setUser(e.target.value)} required autoComplete="off" />}
        <Field label={kind === "basic" ? "Password" : CREDENTIAL_KINDS[kind] ?? "Secret"} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} required autoComplete="new-password" />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={mutation.isPending || !ok} loading={mutation.isPending}>{mutation.isPending ? "Storing…" : "Store"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** A step that needs a written reason (pause, retire, revoke). */
const ReasonDialog = ({ title, action, connection, confirm, tone = "danger", onClose }) => {
  const mutation = useIntegrationMutation();
  const { showToast } = useToast();
  const [reason, setReason] = useState("");
  const go = (e) => {
    e.preventDefault();
    if (reason.trim().length < 3) return;
    mutation.mutate({ action, id: connection.id, body: { reason: reason.trim() } }, { onSuccess: () => onClose(), onError: (err) => showToast({ type: "error", title: "Not done", message: describeApiError(err) }) });
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <form noValidate onSubmit={go} className="flex flex-col gap-3">
        <TextAreaField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required rows={3} maxLength={500} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type={tone} size="md" disabled={mutation.isPending || reason.trim().length < 3} loading={mutation.isPending}>{confirm}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const Fact = ({ label, children }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-xs text-secondary-text">{label}</dt>
    <dd className="text-sm text-primary-text">{children ?? "—"}</dd>
  </div>
);

/** One connection: its settings, credential, test result, what still stops it going live, the steps its status allows, and its history. */
const ConnectionPage = () => {
  const { id } = useParams();
  const query = useIntegrationConnection(id);
  const providers = useIntegrationProviders();
  const mutation = useIntegrationMutation();
  const { can } = usePermissions();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null);
  useBreadcrumbNames([
    { path: `/Settings/Integrations/${id}`, label: query.data?.name },
  ]);
  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <div className="p-4"><ErrorNotice error={query.error} /></div>;
  const c = query.data;
  const manage = can("integrations.manage");
  const approve = can("integrations.approve");
  const credKind = credentialKindFor(c.provider.key, c.config);
  const retired = c.status === "retired";
  const run = (action, message) => mutation.mutate({ action, id: c.id }, { onSuccess: () => message && showToast({ type: "success", title: message }), onError: (err) => showToast({ type: "error", title: "Not done", message: describeApiError(err) }) });
  const button = (label, onClick, type = "neutral", disabled = false) => (
    <CTAButton key={label} buttonType="button" type={type} size="md" onClick={onClick} disabled={disabled || mutation.isPending} loading={mutation.isPending}>{label}</CTAButton>
  );
  const isFile = !!c.fileConnection;
  const actions = [];
  if (isFile) {
    // A file connection is in use from the start: no test, ready, activate, pause or resume (plan §6.9). Edit and retire sit in the "…" menu.
  } else if (manage && !retired) {
    actions.push(button("Edit settings", () => setDialog("edit")));
    actions.push(button("Test connection", () => run("test", "Test finished")));
    if (c.status === "draft") actions.push(button("Mark ready", () => run("ready", "Marked ready"), "main", c.problems.length > 0));
    if (c.status === "active") actions.push(button("Pause", () => setDialog("pause")));
    if (c.status === "paused") actions.push(button("Resume", () => run("resume", "Resumed"), "main"));
    actions.push(button("Retire", () => setDialog("retire"), "danger"));
  }
  if (!isFile && c.canActivate) actions.push(button("Activate", () => run("activate", "Activated"), "main"));
  const fileMenu = isFile && manage && !retired && (
    <RowActionsMenu
      label={`Actions for ${c.name}`}
      items={[
        { label: "Edit settings", onSelect: () => setDialog("edit") },
        { separator: true },
        { label: "Retire", tone: "danger", onSelect: () => setDialog("retire") },
      ]}
    />
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <MenuCard
        title={c.name}
        subtitle={`${c.provider.name} · system code ${c.externalSystem}`}
        action={<div className="flex items-center gap-2">{isFile && c.status === "active" ? <span className="text-xs text-secondary-text">In use</span> : <StatusPill status={c.status} />}{fileMenu}</div>}>
        {isFile ? (
          <p className="text-sm text-secondary-text">
            Upload a file, map its columns, preview it, then import it. Whoever imports a file approves it. {c.activatedAt ? `In use since ${formatDateTime(c.activatedAt)}.` : ""}
          </p>
        ) : (
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Fact label="Last test">{c.lastTest ? `${c.lastTest.ok ? "Passed" : "Failed"} · ${formatDateTime(c.lastTest.at)}${c.lastTest.message ? ` · ${c.lastTest.message}` : ""}` : "Not tested"}</Fact>
          <Fact label="Marked ready">{c.readyAt ? formatDateTime(c.readyAt) : null}</Fact>
          <Fact label="Activated">{c.activatedAt ? formatDateTime(c.activatedAt) : null}</Fact>
        </dl>
        )}
        {!isFile && c.status === "draft" && c.problems.length > 0 && (
          <Callout tone="warning" title="Still needed before this can be marked ready" className="mt-3">
            <ul className="list-disc pl-5">{c.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </Callout>
        )}
        {!isFile && c.status === "ready" && !c.canActivate && (
          <Callout tone="info" className="mt-3">
            Waiting for {approve ? "a different person" : "someone"} with approval rights to activate it. An owner or admin may activate a connection they prepared themselves.
          </Callout>
        )}
        {actions.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
      </MenuCard>

      {credKind && (
        <MenuCard title="Credential" subtitle="Stored encrypted. It is never shown again, only replaced or revoked.">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1 text-sm text-primary-text">
              {c.credential ? `${CREDENTIAL_KINDS[c.credential.kind] ?? c.credential.kind} stored ${formatDateTime(c.credential.setAt)}` : "No credential stored"}
            </span>
            {manage && !retired && button(c.credential ? "Replace" : "Store a credential", () => setDialog("credential"), "main")}
            {manage && !retired && c.credential && button("Revoke", () => setDialog("revoke"), "danger")}
          </div>
        </MenuCard>
      )}

      {c.provider.key === "csv" && <FilesCard connection={c} canUpload={can("integrations.run")} canMap={manage} />}
      {c.provider.kind === "api" && !retired && can("integrations.run") && <ApiSampleCard connection={c} />}
      {c.provider.kind === "api" && <ScheduleCard connection={c} />}
      <MissingCard connectionId={c.id} />
      <AttentionCard connection={c} kinds={c.provider.kind === "api" ? Object.keys(c.config?.entities ?? {}) : (c.importable ?? [])} />

      <ImportsCard connection={c} canRun={can("integrations.run")} />
      {can("receiving.read") && <ReconciliationCard connectionId={c.id} />}

      <MenuCard title="History" subtitle="Every change to this connection, newest first.">
        <details open={!isFile}>
          <summary className="cursor-pointer text-sm text-secondary-text">{isFile ? `Show the history (${c.events.length})` : "History"}</summary>
        <ul aria-label="History" className="mt-2 flex flex-col divide-y divide-border-color">
          {c.events.map((e, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-2 py-1.5 text-sm">
              <span className="font-medium text-primary-text">{EVENT_LABELS[e.action] ?? e.action}</span>
              {e.note && <span className="text-secondary-text">{e.note}</span>}
              <span className="ml-auto text-xs text-secondary-text">{formatDateTime(e.at)}{e.by?.name ? ` · ${e.by.name}` : ""}</span>
            </li>
          ))}
        </ul>
        </details>
      </MenuCard>

      {dialog === "edit" && <ConnectionForm existing={c} providers={providers.data ?? []} onClose={() => setDialog(null)} />}
      {dialog === "credential" && <CredentialDialog connection={c} kind={credKind} onClose={() => setDialog(null)} />}
      {dialog === "revoke" && <ReasonDialog title="Revoke the credential" action="revokeCredential" connection={c} confirm="Revoke" onClose={() => setDialog(null)} />}
      {dialog === "pause" && <ReasonDialog title="Pause this connection" action="pause" connection={c} confirm="Pause" tone="main" onClose={() => setDialog(null)} />}
      {dialog === "retire" && <ReasonDialog title="Retire this connection" action="retire" connection={c} confirm="Retire" onClose={() => setDialog(null)} />}
    </div>
  );
};

export default ConnectionPage;
