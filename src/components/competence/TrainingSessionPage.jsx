import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PlusIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { usePermissions } from "../../hooks/useQmsApi";
import { useCompetenceMutation, useTrainingSession } from "../../hooks/useCompetence";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { ATTENDEE_STATUS, attendeeStatusLabel, kindLabel, pillClass, providerLine, SESSION_STATUS, sessionDates, sessionNextStep, sessionStatusLabel } from "../../lib/competence";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { ErrorNotice } from "../master-data/shared";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import { AttachmentDrop } from "../ui/FileDrop";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import { AddAttendeeDialog, ReasonDialog, RecordDialog, SessionDialog } from "./SessionDialogs";

const Pill = ({ table, status, children }) => <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${pillClass(table, status)}`}>{children}</span>;

/** The drop zone needs a list shaped like a query result; the files come with the session. */
const asList = (files) => ({ data: files, isLoading: false, error: null });
const useFileMutation = () => {
  const mutation = useCompetenceMutation();
  return {
    mutate: ({ path, body }, options) => mutation.mutate({ action: path.endsWith("/restore") ? "restoreFile" : "removeFile", id: path.split("/").at(-2), body }, options),
    reset: mutation.reset,
    isPending: mutation.isPending,
    error: mutation.error,
  };
};

const CertificateDialog = ({ session, attendee, canEdit, onClose }) => {
  const mutation = useFileMutation();
  return (
  <Dialog title={`Certificates for ${attendee.employee.name}`} onClose={onClose} width="max-w-3xl">
    <AttachmentDrop
      recordId={attendee.id}
      bucket="competence-files"
      folder="competence/attendee"
      attachments={asList(attendee.files)}
      mutation={mutation}
      attachUrl={`/competence/training-sessions/${session.id}/attachments`}
      itemBase="/competence/competence-attachments"
      extraBody={{ attendeeId: attendee.id }}
      title="Certificates and evidence"
      subtitle="A certificate, test result or sign-off for this person."
      canEdit={canEdit}
    />
  </Dialog>
  );
};

/** One training session (`/Competence/Training/:id`): facts, supported skills, files and the attendee list, each person completed on their own day. */
const TrainingSessionPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const { showToast } = useToast();
  const mutation = useCompetenceMutation();
  const query = useTrainingSession(id);
  const fileMutation = useFileMutation();
  const [ticked, setTicked] = useState([]);
  const [dialog, setDialog] = useState(null);
  useBreadcrumbNames([{ path: `/Competence/Training/${id}`, label: query.data ? `${query.data.reference} · ${query.data.title}` : null }, { path: "/Competence/Training", label: "Training sessions", to: "/Competence/Training" }]);

  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <ErrorNotice error={query.error} />;
  const s = query.data;
  const canAssess = can("competence.assess");
  const open = s.status === "open";
  const live = s.attendees.filter((a) => !["removed", "voided"].includes(a.status));
  const gone = s.attendees.filter((a) => ["removed", "voided"].includes(a.status));
  const enrolled = live.filter((a) => a.status === "enrolled");
  const selected = enrolled.filter((a) => ticked.includes(a.id));
  const next = sessionNextStep(s);
  const toggle = (a) => setTicked((t) => (t.includes(a.id) ? t.filter((x) => x !== a.id) : [...t, a.id]));
  const run = (payload) =>
    mutation.mutate(payload, { onError: (err) => showToast({ type: "error", title: "Not done", message: describeApiError(err) }) });

  return (
    <div className="flex w-full flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-secondary-text">{s.reference}</p>
          <h1 className="text-2xl font-semibold text-primary-text">{s.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-secondary-text">
            <Pill table={SESSION_STATUS} status={s.status}>
              {sessionStatusLabel(s.status)}
            </Pill>
            <span>
              {kindLabel(s.kind)} · {sessionDates(s)}
              {s.hours ? ` · ${s.hours} h` : ""}
              {s.location ? ` · ${s.location}` : ""}
            </span>
          </div>
        </div>
        {canAssess && s.status !== "cancelled" && (
          <div className="flex flex-wrap gap-2">
            {open && (
              <CTAButton buttonType="button" type="neutral" onClick={() => setDialog({ type: "edit" })}>
                Edit
              </CTAButton>
            )}
            {open && (
              <CTAButton buttonType="button" type="success" disabled={enrolled.length > 0 || mutation.isPending} loading={mutation.isPending && mutation.variables?.action === "closeSession"} onClick={() => run({ action: "closeSession", id: s.id })}>
                Close session
              </CTAButton>
            )}
            {s.status === "closed" && (
              <CTAButton buttonType="button" type="secondary" onClick={() => setDialog({ type: "reopen" })}>
                Reopen
              </CTAButton>
            )}
            {open && (
              <CTAButton buttonType="button" type="danger" onClick={() => setDialog({ type: "cancel" })}>
                Cancel session
              </CTAButton>
            )}
          </div>
        )}
      </header>

      {s.status === "cancelled" ? (
        <Callout tone="warning" title="This session was cancelled">
          {s.cancelReason}
        </Callout>
      ) : (
        next && <Callout tone="info">{next}</Callout>
      )}
      {s.reopenReason && open && <Callout tone="info">Reopened: {s.reopenReason}</Callout>}

      <MenuCard title="About" subtitle="Training is evidence. It does not make anyone competent by itself: record an assessment on the person's page.">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-secondary-text">{s.providerType === "internal" ? "Trainer (internal)" : "Provider (external)"}</dt>
            <dd className="text-primary-text">{providerLine(s)}</dd>
          </div>
          <div>
            <dt className="text-secondary-text">Skills it supports</dt>
            <dd className="text-primary-text">{s.skills.length ? s.skills.map((k) => k.name).join(", ") : "None named"}</dd>
          </div>
          {s.notes && (
            <div className="sm:col-span-2">
              <dt className="text-secondary-text">Notes</dt>
              <dd className="text-primary-text">{s.notes}</dd>
            </div>
          )}
        </dl>
      </MenuCard>

      <MenuCard
        title="Attendees"
        subtitle={`${live.length} on the list · ${s.completedCount} completed`}
        action={
          canAssess && open && (
            <div className="flex gap-2">
              <CTAButton buttonType="button" type="secondary" icon={PlusIcon} onClick={() => setDialog({ type: "add" })}>
                Add a person
              </CTAButton>
              <CTAButton buttonType="button" type="main" disabled={selected.length === 0} onClick={() => setDialog({ type: "record" })}>
                Record a result{selected.length ? ` (${selected.length})` : ""}
              </CTAButton>
            </div>
          )
        }>
        {live.length === 0 ? (
          <p className="text-sm text-secondary-text">No one is on this session.</p>
        ) : (
          <ul aria-label="Attendees" className="flex flex-col divide-y divide-border-color">
            {live.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-2">
                {canAssess && open && a.status === "enrolled" ? (
                  <input type="checkbox" aria-label={`Select ${a.employee.name}`} checked={ticked.includes(a.id)} onChange={() => toggle(a)} className="h-4 w-4" />
                ) : (
                  <span className="w-4" />
                )}
                <div className="min-w-48 flex-1">
                  <Link to={`/Competence/People/${a.employee.id}`} className="text-sm font-medium text-primary-text hover:underline">
                    {a.employee.name}
                  </Link>
                  <p className="text-xs text-secondary-text">
                    {a.completedOn ? `${a.status === "failed" ? "Failed" : "Completed"} on ${a.completedOn}` : ""}
                    {a.note ? `${a.completedOn ? " · " : ""}${a.note}` : ""}
                    {a.recordedBy ? ` · recorded by ${a.recordedBy}` : ""}
                  </p>
                </div>
                <Pill table={ATTENDEE_STATUS} status={a.status}>
                  {attendeeStatusLabel(a.status)}
                </Pill>
                {a.status !== "enrolled" && (
                  <CTAButton buttonType="button" type="neutral" aria-label={`Files for ${a.employee.name}`} onClick={() => setDialog({ type: "files", id: a.id })}>
                    Files{a.files.filter((f) => !f.deletedAt).length ? ` (${a.files.filter((f) => !f.deletedAt).length})` : ""}
                  </CTAButton>
                )}
                {canAssess && open && a.status === "enrolled" && (
                  <CTAButton buttonType="button" type="neutral" aria-label={`Remove ${a.employee.name}`} onClick={() => setDialog({ type: "remove", attendee: a })}>
                    Remove
                  </CTAButton>
                )}
                {canAssess && open && ["completed", "failed", "absent"].includes(a.status) && (
                  <CTAButton buttonType="button" type="neutral" aria-label={`Void ${a.employee.name}`} onClick={() => setDialog({ type: "void", attendee: a })}>
                    Void
                  </CTAButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {gone.length > 0 && (
          <details className="mt-2 text-sm text-secondary-text">
            <summary className="cursor-pointer">Removed or voided ({gone.length})</summary>
            <ul className="mt-1 flex flex-col gap-1">
              {gone.map((a) => (
                <li key={a.id}>
                  {a.employee.name} · {attendeeStatusLabel(a.status)}
                  {a.completedOn ? ` (was ${a.completedOn})` : ""} · {a.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </MenuCard>

      <MenuCard title="Files" subtitle="Sign-in sheets, slides and anything shared by the whole session.">
        <AttachmentDrop
          recordId={s.id}
          bucket="competence-files"
          folder="competence/session"
          attachments={asList(s.files)}
          mutation={fileMutation}
          attachUrl={`/competence/training-sessions/${s.id}/attachments`}
          itemBase="/competence/competence-attachments"
          title="Session files"
          canEdit={canAssess && s.status !== "cancelled"}
        />
      </MenuCard>

      {dialog?.type === "edit" && <SessionDialog existing={s} onClose={() => setDialog(null)} />}
      {dialog?.type === "add" && <AddAttendeeDialog session={s} onClose={() => setDialog(null)} />}
      {dialog?.type === "record" && <RecordDialog session={s} attendees={selected} onClose={() => {
          setDialog(null);
          setTicked([]);
        }} />}
      {dialog?.type === "remove" && (
        <ReasonDialog title={`Remove ${dialog.attendee.employee.name}`} intro="They stay in the history as removed." action="removeAttendee" id={dialog.attendee.id} confirm="Remove" onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "void" && (
        <ReasonDialog
          title={`Void ${dialog.attendee.employee.name}'s result`}
          intro="The result is kept as voided. You can add them again afterwards and record the right result."
          action="voidAttendee"
          id={dialog.attendee.id}
          confirm="Void"
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === "reopen" && <ReasonDialog title={`Reopen ${s.reference}`} action="reopenSession" id={s.id} confirm="Reopen" onClose={() => setDialog(null)} />}
      {dialog?.type === "cancel" && (
        <ReasonDialog title={`Cancel ${s.reference}`} intro="Only a session with no recorded results can be cancelled." action="cancelSession" id={s.id} confirm="Cancel session" onClose={() => setDialog(null)} />
      )}
      {dialog?.type === "files" && (
        <CertificateDialog session={s} attendee={s.attendees.find((a) => a.id === dialog.id)} canEdit={canAssess && s.status !== "cancelled"} onClose={() => setDialog(null)} />
      )}
    </div>
  );
};

export default TrainingSessionPage;
