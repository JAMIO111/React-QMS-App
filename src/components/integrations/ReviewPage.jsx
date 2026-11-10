import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useToast } from "../../contexts/ToastProvider";
import { useDecideConflict, useIntegrationConflicts } from "../../hooks/useIntegrations";
import { describeApiError } from "../../lib/api-client";
import { ENTITY_LABELS, recordPath } from "../../lib/integrations";
import { formatDateTime } from "../../lib/processControl";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice, TextAreaField } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";

const STATUS_WORDS = {
  open: { label: "Waiting", tone: "bg-warning-color/15 text-warning-color" },
  accepted: { label: "Accepted", tone: "bg-success-color/15 text-success-color" },
  rejected: { label: "Fortress kept its value", tone: "bg-border-color text-secondary-text" },
  superseded: { label: "Replaced", tone: "bg-border-color text-secondary-text" },
};

const Value = ({ label, value }) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <span className="text-xs text-secondary-text">{label}</span>
    <span className={`truncate rounded-lg bg-secondary-bg px-2 py-1 text-sm ${value === null ? "text-tertiary-text" : "text-primary-text"}`} title={value ?? "(empty)"}>
      {value ?? "(empty)"}
    </span>
  </div>
);

/** Keep Fortress's value: a reason is needed, and the same value is not asked about again. */
const RejectDialog = ({ conflict, onCancel, onConfirm }) => {
  const [reason, setReason] = useState("");
  const ok = reason.trim().length >= 3;
  return (
    <Dialog title={`Keep Fortress's ${conflict.field.label.toLowerCase()}`} onClose={onCancel}>
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ok) onConfirm(reason.trim()); }}>
        <p className="text-sm text-secondary-text">
          {conflict.record.label ?? "The record"} keeps <strong>{conflict.fortressValue ?? "(empty)"}</strong>. The source's value <strong>{conflict.sourceValue ?? "(empty)"}</strong> will not be asked about again unless it changes.
        </p>
        <TextAreaField label="Why does Fortress keep its value?" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} required maxLength={1000} />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onCancel}>Back</CTAButton>
          <CTAButton type="main" size="md" buttonType="submit" disabled={!ok}>Keep Fortress's value</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const ConflictCard = ({ c, onAccept, onReject }) => {
  const path = recordPath(c.entityType, c.record.id);
  const s = STATUS_WORDS[c.status];
  return (
    <li aria-label={`${c.record.label ?? "Record"}: ${c.field.label}`} className="flex flex-col gap-3 rounded-xl border border-border-color bg-primary-bg p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs text-secondary-text">{ENTITY_LABELS[c.entityType] ?? c.entityType} · {c.connection.name} · source id {c.externalId}</span>
          <span className="text-sm font-medium text-primary-text">
            {path && c.record.label ? <Link to={path} className="text-link-color hover:underline">{c.record.label}</Link> : (c.record.label ?? "A record you cannot see")}
            <span className="text-secondary-text"> · {c.field.label}</span>
          </span>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Value label="Fortress has" value={c.fortressValue} />
        <Value label="The source sent" value={c.sourceValue} />
      </div>
      {c.applyError && c.status === "open" && (
        <Callout tone="warning" title="Fortress cannot take this value">{c.applyError}. Keep Fortress's value, or change the record first.</Callout>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-secondary-text">
          Held back {formatDateTime(c.createdAt)} · <Link to={`/Settings/Integrations/${c.connection.id}/runs/${c.runId}`} className="text-link-color hover:underline">the import</Link>
          {c.decidedAt && ` · ${c.status === "accepted" ? "accepted" : "kept"} ${formatDateTime(c.decidedAt)}${c.decidedBy ? ` by ${c.decidedBy.name}` : ""}`}
          {c.decisionNote && ` · "${c.decisionNote}"`}
        </span>
        {c.canDecide && (
          <div className="flex gap-2">
            <CTAButton type="neutral" size="md" onClick={() => onReject(c)}>Keep Fortress's</CTAButton>
            <CTAButton type="main" size="md" onClick={() => onAccept(c)} disabled={!!c.applyError}>Accept</CTAButton>
          </div>
        )}
      </div>
    </li>
  );
};

/**
 * Settings → Integrations → Values to review (IN5). A field set to "Review" in an import template is never changed by a later import: a different value
 * waits here. Accepting writes it (as you, under the record's own rules); keeping Fortress's value needs a reason. Both are optimistic.
 */
const ReviewPage = () => {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "open";
  const runId = params.get("run") ?? undefined;
  const [page, setPage] = useState(1);
  const list = useIntegrationConflicts({ status, runId, page });
  const decide = useDecideConflict();
  const { showToast } = useToast();
  const [rejecting, setRejecting] = useState(null);
  const set = (k, v) => {
    setPage(1);
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (v) next.set(k, v);
      else next.delete(k);
      return next;
    }, { replace: true });
  };
  const send = (c, accept, note) =>
    decide.mutate(
      { id: c.id, accept, note },
      {
        onSuccess: () => showToast({ type: "success", title: accept ? "Accepted" : "Fortress kept its value", message: `${c.record.label ?? "The record"} · ${c.field.label}` }),
        onError: (e) => showToast({ type: "error", title: "Not done", message: describeApiError(e) }),
      },
    );
  const data = list.data;
  const items = data?.data ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="flex flex-col gap-4 p-4">
      <MenuCard
        title="Values to review"
        subtitle="Fields set to Review in an import template are not changed by a later import. When the source sends a different value it waits here."
        action={<CTAButton to="/Settings/Integrations" type="neutral" size="md">Integrations</CTAButton>}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <SlidingToggle
              ariaLabel="Which values"
              value={status}
              onChange={(v) => set("status", v === "open" ? null : v)}
              options={[
                { value: "open", label: "Waiting", count: data?.openCount },
                { value: "decided", label: "Decided" },
                { value: "all", label: "All" },
              ]}
            />
            {runId && (
              <span className="inline-flex items-center gap-2 rounded-full bg-border-color px-3 py-1 text-xs text-primary-text">
                From one import
                <button type="button" className="text-link-color hover:underline" onClick={() => set("run", null)}>Show all</button>
              </span>
            )}
          </div>
          {list.isLoading ? (
            <LoadingScreen size="sm" />
          ) : list.error ? (
            <ErrorNotice error={list.error} />
          ) : items.length === 0 ? (
            <p className="rounded-lg border-2 border-dashed border-border-dark-color p-4 text-center text-sm text-secondary-text">
              {status === "open" ? "Nothing is waiting for review." : "No values here."}
            </p>
          ) : (
            <ul aria-label="Values" className="flex flex-col gap-2">
              {items.map((c) => <ConflictCard key={c.id} c={c} onAccept={(x) => send(x, true)} onReject={setRejecting} />)}
            </ul>
          )}
          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 text-sm text-secondary-text">
              <CTAButton type="neutral" size="md" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</CTAButton>
              <span>Page {page} of {pages}</span>
              <CTAButton type="neutral" size="md" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</CTAButton>
            </div>
          )}
        </div>
      </MenuCard>
      {rejecting && (
        <RejectDialog
          conflict={rejecting}
          onCancel={() => setRejecting(null)}
          onConfirm={(reason) => {
            send(rejecting, false, reason);
            setRejecting(null);
          }}
        />
      )}
    </div>
  );
};

export default ReviewPage;
