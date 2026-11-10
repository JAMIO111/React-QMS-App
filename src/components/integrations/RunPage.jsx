import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useToast } from "../../contexts/ToastProvider";
import { useIntegrationConnection, useIntegrationMutation, useIntegrationRun, useIntegrationRunRows } from "../../hooks/useIntegrations";
import { usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { ENTITY_LABELS, ROW_STATUS, RUN_KINDS, WRITE_MODE_LABELS, drainMessage, isLive, wizardPath } from "../../lib/integrations";
import { formatDateTime } from "../../lib/processControl";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import StatTile from "../ui/StatTile";

import { ErrorNotice, FormError, TextAreaField } from "../master-data/shared";
import { RunStatusPill } from "./ImportsCard";
import CTAButton from "@/components/CTAButton";

const CancelDialog = ({ run, onClose }) => {
  const mutation = useIntegrationMutation();
  const { showToast } = useToast();
  const [reason, setReason] = useState("");
  const go = (e) => {
    e.preventDefault();
    if (reason.trim().length < 3) return;
    mutation.mutate({ action: "cancelRun", id: run.id, body: { reason: reason.trim() } }, { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not cancelled", message: describeApiError(err) }) });
  };
  return (
    <Dialog title="Cancel this import" onClose={onClose}>
      <form noValidate onSubmit={go} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">Records already applied stay. Rows not yet applied are left as they are.</p>
        <TextAreaField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required rows={3} maxLength={1000} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Keep it</CTAButton>
          <CTAButton buttonType="submit" type="danger" size="md" disabled={mutation.isPending || reason.trim().length < 3} loading={mutation.isPending}>Cancel import</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const FILTERS = ["all", "failed", "rejected", "skipped", "applied", "unchanged", "previewed", "superseded"];

/** The rows of a run: identifier, source row, what happened, why it did not apply, and the record as it arrived. */
const RowsCard = ({ run }) => {
  const [filter, setFilter] = useState(run.counts.failed > 0 ? "failed" : "all");
  const [page, setPage] = useState(1);
  const rows = useIntegrationRunRows(run.id, filter === "all" ? null : filter, page);
  const data = rows.data?.data ?? [];
  const total = rows.data?.total ?? 0;
  const counts = { all: Object.values(run.rowsNow).reduce((a, b) => a + b, 0), ...run.rowsNow };
  const options = FILTERS.filter((f) => f === "all" || counts[f] > 0).map((f) => ({ value: f, label: f === "all" ? "All" : ROW_STATUS[f], count: counts[f] }));
  return (
    <MenuCard title="Rows" subtitle="Every record the import read, and what happened to it.">
      <SlidingToggle ariaLabel="Show rows" options={options} value={filter} onChange={(v) => { setFilter(v); setPage(1); }} />
      {rows.error ? <ErrorNotice error={rows.error} /> : (
        <ul aria-label="Rows" className="mt-3 flex flex-col divide-y divide-border-color">
          {data.length === 0 && !rows.isLoading && <li className="py-2 text-sm text-secondary-text">No rows.</li>}
          {data.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-primary-text">{r.externalId ?? "No identifier"}</span>
                {r.sourceRow != null && <span className="text-xs text-secondary-text">row {r.sourceRow}</span>}
                <span className="text-xs text-secondary-text">{ROW_STATUS[r.status]}{r.action ? ` (${r.status === "previewed" ? "would " : ""}${r.action})` : ""}</span>
              </div>
              {r.errors.map((e, i) => (
                <p key={i} className="text-xs text-error-color">{e.field ? `${e.field}: ` : ""}{e.message}</p>
              ))}
              {r.payload ? (
                <details className="text-xs">
                  <summary className="cursor-pointer text-secondary-text">Record as it arrived</summary>
                  <pre className="mt-1 overflow-x-auto rounded-lg bg-secondary-bg p-2 text-primary-text">{JSON.stringify(r.payload, null, 2)}</pre>
                </details>
              ) : r.purgedAt ? <span className="text-xs text-secondary-text">The record was cleared on {formatDateTime(r.purgedAt)} (kept for 90 days).</span> : null}
            </li>
          ))}
        </ul>
      )}
      {total > 50 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-sm text-secondary-text">
          <CTAButton type="neutral" size="md" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</CTAButton>
          <span>Page {page} of {Math.ceil(total / 50)}</span>
          <CTAButton type="neutral" size="md" disabled={page * 50 >= total} onClick={() => setPage((p) => p + 1)}>Next</CTAButton>
        </div>
      )}
    </MenuCard>
  );
};

/** One import run: what it was, how far it got, its figures and errors, and the actions its state allows. */
const RunPage = () => {
  const { id, runId } = useParams();
  const query = useIntegrationRun(runId);
  const connection = useIntegrationConnection(id);
  const mutation = useIntegrationMutation();
  const { can } = usePermissions();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState(null);
  useBreadcrumbNames([
    { path: `/Settings/Integrations/${id}`, label: connection.data?.name },
    { path: `/Settings/Integrations/${id}/runs`, to: `/Settings/Integrations/${id}` },
    { path: `/Settings/Integrations/${id}/runs/${runId}`, label: query.data ? `${RUN_KINDS[query.data.kind]} ${formatDateTime(query.data.requestedAt)}` : null },
  ]);
  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <div className="p-4"><ErrorNotice error={query.error} /></div>;
  const run = query.data;
  const canRun = can("integrations.run");
  const preview = run.kind === "preview";
  const live = isLive(run);
  const act = (action, body) =>
    mutation.mutate(
      { action, id: action === "retryRows" ? id : run.id, body },
      {
        onSuccess: (r) => setNotice(drainMessage(r?.drain)),
        onError: (err) => showToast({ type: "error", title: "Not done", message: describeApiError(err) }),
      },
    );
  // After a preview of a file: the same file and template (its current version) or mapping, written this time.
  const importFile = () =>
    mutation.mutate(
      { action: "requestRun", id, body: { entityType: run.entityType, kind: "full", fileId: run.file.id, ...(run.template ? { templateId: run.template.id } : {}) } },
      {
        onSuccess: (r) => navigate(`/Settings/Integrations/${id}/runs/${r.id}`),
        onError: (err) => showToast({ type: "error", title: "Import not started", message: describeApiError(err) }),
      },
    );
  return (
    <div className="flex flex-col gap-4 p-4">
      <MenuCard
        title={`${RUN_KINDS[run.kind]} · ${ENTITY_LABELS[run.entityType] ?? run.entityType}`}
        subtitle={`${run.connection.name} · asked for ${formatDateTime(run.requestedAt)}${run.requestedBy ? ` by ${run.requestedBy.name}` : ""}${run.finishedAt ? ` · finished ${formatDateTime(run.finishedAt)}` : ""}${run.file ? ` · file ${run.file.name}` : ""}${run.template ? ` · template ${run.template.name} version ${run.template.version}` : run.mappingVersion ? ` · mapping version ${run.mappingVersion}` : ""}${run.settings ? ` · ${WRITE_MODE_LABELS[run.settings.writeMode]?.toLowerCase() ?? run.settings.writeMode}` : ""}`}
        action={<RunStatusPill status={run.status} />}>
        <div className="flex flex-wrap gap-3">
          <StatTile label="Rows read" value={run.counts.total} />
          <StatTile label={preview ? "Would be created" : "Created"} value={run.counts.created} />
          <StatTile label={preview ? "Would be updated" : "Updated"} value={run.counts.updated} />
          <StatTile label="Unchanged" value={run.counts.unchanged} note="Nothing written" />
          {run.counts.skipped > 0 && <StatTile label="Skipped" value={run.counts.skipped} note="Left alone by the settings" />}
          <StatTile label="Rejected" value={run.counts.rejected} note="Problems in the source" />
          {!preview && <StatTile label="Failed" value={run.counts.failed} note="Can be retried" />}
          {run.counts.parked > 0 && <StatTile label="To review" value={run.counts.parked} note="Values held back" />}
        </div>
        {run.counts.parked > 0 && (
          <Callout
            tone="warning"
            className="mt-3"
            title={run.counts.parked === 1 ? "1 value is waiting for review" : `${run.counts.parked} values are waiting for review`}
            action={<CTAButton to={`/Settings/Integrations/Review?run=${run.id}`} type="secondary" size="md">Review values</CTAButton>}>
            Fields set to Review were not changed where the source sent a different value. Accept a value to write it, or keep Fortress's.
          </Callout>
        )}
        {preview && <Callout tone="info" className="mt-3">A preview writes nothing. It shows what a real import would do now.</Callout>}
        {run.nextAttemptAt && <Callout tone="warning" className="mt-3" title="Waiting to try again">{run.errorSummary} It will be tried again from {formatDateTime(run.nextAttemptAt)}.</Callout>}
        {run.status === "failed" && run.errorSummary && <Callout tone="error" className="mt-3" title="The import failed">{run.errorSummary}</Callout>}
        {run.status === "cancelled" && <Callout tone="info" className="mt-3" title="Cancelled">{run.cancelReason}{run.cancelledBy ? ` (${run.cancelledBy.name})` : ""}</Callout>}
        {notice && <Callout tone="info" className="mt-3" role="status">{notice}</Callout>}
        {canRun && (
          <div className="mt-3 flex flex-wrap gap-2">
            {live && !run.nextAttemptAt && <CTAButton type="main" size="md" disabled={mutation.isPending} loading={mutation.isPending} onClick={() => act("continueRun", {})}>{mutation.isPending ? "Working…" : "Continue"}</CTAButton>}
            {live && <CTAButton type="danger" size="md" onClick={() => setCancelling(true)}>Cancel import</CTAButton>}
            {!live && run.rowsNow.failed > 0 && connection.data?.status === "active" && (
              <CTAButton type="main" size="md" disabled={mutation.isPending} loading={mutation.isPending} onClick={() => act("retryRows", { entityType: run.entityType })}>{mutation.isPending ? "Retrying…" : "Retry failed rows"}</CTAButton>
            )}
            {preview && run.file && !live && run.status !== "cancelled" && connection.data?.status === "active" && (
              <>
                {(connection.data.importable ?? []).includes(run.entityType) && (connection.data.writable ?? []).includes(run.entityType) && (
                  <CTAButton type="main" size="md" disabled={mutation.isPending} loading={mutation.isPending} onClick={importFile}>{mutation.isPending ? "Starting…" : "Import these records"}</CTAButton>
                )}
                <CTAButton to={wizardPath(id, { entity: run.entityType, file: run.file.id, step: 3, template: run.template?.id })} type="secondary" size="md">Change the mapping</CTAButton>
              </>
            )}
          </div>
        )}
      </MenuCard>

      {run.errors.length > 0 && (
        <MenuCard title="Problems reading the source" subtitle="Every attempt that could not read or stage the source.">
          <ul className="flex flex-col divide-y divide-border-color">
            {run.errors.map((e, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-2 py-1.5 text-sm">
                <span className="font-medium text-primary-text">Attempt {e.attempt}</span>
                <span className="text-secondary-text">{e.message}</span>
                <span className="ml-auto text-xs text-secondary-text">{e.transient ? "tried again" : "not retried"} · {formatDateTime(e.at)}</span>
              </li>
            ))}
          </ul>
        </MenuCard>
      )}

      <RowsCard run={run} />
      {cancelling && <CancelDialog run={run} onClose={() => setCancelling(false)} />}
    </div>
  );
};

export default RunPage;
