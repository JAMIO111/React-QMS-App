import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useToast } from "../../contexts/ToastProvider";
import { useIntegrationMutation, useIntegrationRuns } from "../../hooks/useIntegrations";
import { describeApiError } from "../../lib/api-client";
import { ENTITY_LABELS, RUN_KINDS, RUN_STATUS, runSummary } from "../../lib/integrations";
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
  const [entityType, setEntityType] = useState(connection.runnable[0] ?? null);
  const [kind, setKind] = useState("preview");
  const kinds = [
    { value: "preview", label: "Preview" },
    { value: "full", label: "Full", disabled: !active },
    { value: "incremental", label: "Incremental", disabled: !active },
  ];
  const go = (e) => {
    e.preventDefault();
    if (!entityType) return;
    mutation.mutate(
      { action: "requestRun", id: connection.id, body: { entityType, kind } },
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
        <ComboField label="Records" value={entityType} onChange={setEntityType} options={connection.runnable.map((t) => ({ value: t, label: ENTITY_LABELS[t] ?? t }))} required />
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-primary-text">What to do</span>
          <SlidingToggle ariaLabel="What to do" options={kinds} value={kind} onChange={setKind} />
        </div>
        <Callout tone="info">
          {kind === "preview"
            ? "A preview reads the source and shows what would be created, updated or rejected. Nothing is written."
            : kind === "full"
              ? "Reads everything from the start. Records already in Fortress and unchanged are left alone."
              : "Carries on from where the last import stopped."}
          {!active && " Full and incremental imports need the connection to be active."}
        </Callout>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={mutation.isPending || !entityType}>{mutation.isPending ? "Running…" : "Run"}</CTAButton>
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
      {!runnable && <Callout tone="info" className="mb-3">Importing through this connection arrives with the file importer and the record importers (the next slices). Nothing can be imported yet.</Callout>}
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
