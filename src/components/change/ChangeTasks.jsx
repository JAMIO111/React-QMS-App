import { useState } from "react";
import { Link } from "react-router-dom";
import CTAButton from "@/components/CTAButton";
import { CheckIcon, PencilIcon, PlusIcon, RotateCcwIcon, XIcon } from "@/components/icons";
import { useChangeAreas, useChangeMutation, useChangeSigners } from "../../hooks/useChange";
import { useControlPlan, useControlPlans } from "../../hooks/useProcessControl";
import { useDocument, useDocuments } from "../../hooks/useDocuments";
import { useFmea, useFmeas } from "../../hooks/useFmea";
import { usePart } from "../../hooks/useMasterData";
import { useDebouncedSearch } from "../../hooks/useDebouncedSearch";
import { revisionLabel as partRevisionLabel } from "../../lib/partRevisions";
import { formatDay, linkStateLabel, linkStatePill, REVISION_KINDS, reviewLabel, reviewPill, taskLabel, taskLinkKindLabel, taskLinkPath, taskPill } from "../../lib/change";
import { FormError, TextAreaField } from "../master-data/shared";
import { PartPicker, RemoteComboBox } from "../ncr/Pickers";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { avatarOf } from "@/lib/employees";

const Buttons = ({ onClose, pending, disabled, label, type = "main" }) => (
  <div className="flex justify-end gap-2">
    <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
      Cancel
    </CTAButton>
    <CTAButton buttonType="submit" type={type} size="md" disabled={disabled || pending} loading={pending}>
      {label}
    </CTAButton>
  </div>
);

/** Add a task to an approved change, or change an open one. */
const TaskDialog = ({ change, existing, onClose }) => {
  const mutation = useChangeMutation();
  const people = useChangeSigners();
  const areas = useChangeAreas();
  const [description, setDescription] = useState(existing?.description ?? "");
  const [ownerId, setOwnerId] = useState(existing?.owner?.id ?? null);
  const [dueOn, setDueOn] = useState(existing?.dueOn ?? "");
  const [areaId, setAreaId] = useState(existing?.area?.id ?? null);
  const ready = description.trim().length >= 3 && !!ownerId;
  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { description: description.trim(), ownerId, dueOn: dueOn || null, areaId: areaId || null };
    mutation.mutate(existing ? { action: "updateTask", id: existing.id, body } : { action: "addTask", id: change.id, body }, { onSuccess: onClose });
  };
  const impacts = change.impacts?.filter((i) => i.status === "affected") ?? [];
  const areaOptions = (areas.data?.data ?? []).filter((a) => a.active || a.id === existing?.area?.id).map((a) => ({ value: a.id, label: a.label, hint: impacts.some((i) => i.areaId === a.id) ? "Affected by this change" : undefined }));
  return (
    <Dialog title={existing ? "Change the task" : "Add a task"} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <TextAreaField label="What has to be done" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={3} required />
        <ComboField label="Who does it" required value={ownerId} onChange={setOwnerId} options={(people.data ?? []).map((p) => ({ value: p.id, label: p.name, avatar: avatarOf(p) }))} placeholder="Choose a person" />
        <RHFDatePickerPopout label="By when" value={dueOn} onChange={(v) => setDueOn(v ?? "")} valueFormat="iso" clearable />
        <ComboField label="Impact area" value={areaId} onChange={setAreaId} options={areaOptions} sort={false} clearable hint="Optional: which part of the business this task is for" />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label={existing ? "Save" : "Add task"} />
      </form>
    </Dialog>
  );
};

/** A note (finishing) or a reason (cancelling, reopening). */
const NoteDialog = ({ title, intro, label, required, action, task, submit, tone = "main", onClose }) => {
  const mutation = useChangeMutation();
  const [text, setText] = useState("");
  const ready = !required || text.trim().length >= 3;
  const send = (e) => {
    e.preventDefault();
    if (!ready) return;
    mutation.mutate({ action, id: task.id, body: submit(text.trim()) }, { onSuccess: onClose });
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <form noValidate onSubmit={send} className="flex flex-col gap-3">
        {intro && <p className="text-sm text-secondary-text">{intro}</p>}
        <TextAreaField label={label} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} rows={3} required={required} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label={title} type={tone} />
      </form>
    </Dialog>
  );
};

const documentOption = (d) => ({ id: d.id, name: `${d.number} · ${d.title}`, hint: d.status === "draft" ? "not in force yet" : undefined });
const planOption = (p) => ({ id: p.id, name: `${p.planCode} · ${p.title}` });

/**
 * Start the next revision of a part, a control plan or a document for a task and point the task at it. The revision is made as the person asking, so
 * the part, plan and document modules' own rules and rights apply; the task then shows where it stands.
 */
const StartRevisionDialog = ({ task, onClose }) => {
  const mutation = useChangeMutation();
  const [kind, setKind] = useState("part");
  const [partId, setPartId] = useState(null);
  const [planId, setPlanId] = useState(null);
  const [documentId, setDocumentId] = useState(null);
  const [fmeaId, setFmeaId] = useState(null);
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [planQ, setPlanSearch] = useDebouncedSearch();
  const [docQ, setDocSearch] = useDebouncedSearch();
  const [fmeaQ, setFmeaSearch] = useDebouncedSearch();
  const plans = useControlPlans({ q: planQ, pageSize: 20 });
  const documents = useDocuments({ q: docQ, status: "active", pageSize: 20 });
  const fmeas = useFmeas({ q: fmeaQ, status: "active", pageSize: 20 }, { enabled: kind === "fmea" });
  const ready = kind === "part" ? !!partId && code.trim() : kind === "control_plan" ? !!planId && code.trim() : kind === "fmea" ? !!fmeaId : !!documentId;
  const start = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body =
      kind === "part"
        ? { kind, partId, revision: code.trim(), changeSummary: note.trim() || null }
        : kind === "control_plan"
          ? { kind, planId, revisionCode: code.trim(), changeReason: note.trim() || null }
          : kind === "fmea"
            ? { kind, fmeaId }
            : { kind, documentId };
    mutation.mutate({ action: "startRevision", id: task.id, body }, { onSuccess: onClose });
  };
  return (
    <Dialog title="Start a revision for this task" onClose={onClose}>
      <form noValidate onSubmit={start} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">A draft revision is made now, as you, and the task points at it. The task can be finished once the revision is in force.</p>
        <ComboField label="What to revise" required value={kind} onChange={setKind} options={REVISION_KINDS} sort={false} />
        {kind === "part" && <PartPicker label="Part" value={partId} onChange={(id) => setPartId(id)} required />}
        {kind === "control_plan" && (
          <RemoteComboBox
            label="Control plan"
            required
            placeholder="Search a control plan…"
            value={planId}
            onChange={(id) => setPlanId(id)}
            items={(plans.data?.data ?? []).map(planOption)}
            isFetching={plans.isFetching}
            onSearch={setPlanSearch}
          />
        )}
        {kind === "document" && (
          <RemoteComboBox
            label="Document"
            required
            placeholder="Search a document in force…"
            value={documentId}
            onChange={(id) => setDocumentId(id)}
            items={(documents.data?.data ?? []).map(documentOption)}
            isFetching={documents.isFetching}
            onSearch={setDocSearch}
          />
        )}
        {kind === "fmea" && (
          <RemoteComboBox
            label="FMEA"
            required
            placeholder="Search an FMEA in force…"
            value={fmeaId}
            onChange={(id) => setFmeaId(id)}
            items={(fmeas.data?.data ?? []).map((f) => ({ id: f.id, name: `${f.number} · ${f.title}`, hint: f.currentLetter ? `Rev ${f.currentLetter}` : undefined }))}
            isFetching={fmeas.isFetching}
            onSearch={setFmeaSearch}
          />
        )}
        {kind !== "document" && kind !== "fmea" && <Field label="New revision letter or code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={10} required hint="For example B" />}
        {kind !== "document" && kind !== "fmea" && <TextAreaField label={kind === "part" ? "What changes" : "Why it changes"} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} />}
        {kind === "document" && <p className="text-sm text-secondary-text">The new draft starts as a copy of the revision in force, with its text and files.</p>}
        {kind === "fmea" && <p className="text-sm text-secondary-text">The new draft starts as a copy of the revision in force: its team, scope and analysis. Say what changed on the revision.</p>}
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label="Start the revision" />
      </form>
    </Dialog>
  );
};

/** The kind of record a task points at, for each thing whose revision can be chosen. */
const TASK_KIND_OF = { part: "part_revision", control_plan: "control_plan_revision", document: "document_revision", fmea: "fmea_revision" };
const wordsOf = (status) => String(status ?? "").replaceAll("_", " ");

/** The revisions of the chosen record that can still change what is in force (not discarded, withdrawn or replaced), with what each is called and where it stands. */
const revisionOptions = (kind, record) => {
  const rows = record?.revisions ?? [];
  const live = (statuses) => rows.filter((r) => statuses.includes(r.status));
  switch (kind) {
    case "part":
      return live(["draft", "released"]).map((r) => ({ value: r.id, label: `Rev ${partRevisionLabel(r)}`, hint: wordsOf(r.status) }));
    case "control_plan":
      return live(["draft", "pending_approval", "approved", "effective"]).map((r) => ({ value: r.id, label: `Rev ${r.revisionCode}`, hint: wordsOf(r.status) }));
    case "document":
      return live(["draft", "in_review", "awaiting_approval", "approved", "effective"]).map((r) => ({ value: r.id, label: r.letter ? `Rev ${r.letter}` : `Draft ${r.sequence}`, hint: wordsOf(r.status) }));
    default:
      return live(["draft", "pending_approval", "approved", "effective"]).map((r) => ({ value: r.id, label: r.letter ? `Rev ${r.letter}` : `Draft ${r.sequence}`, hint: wordsOf(r.status) }));
  }
};

/**
 * Point a task at a revision that already exists (a draft someone has started, or the one in force): choose the part, control plan, document or FMEA, then which of its
 * revisions. The task then shows where that revision stands, and can be finished once it is in force. Nothing is made: Start a revision is for a new one.
 */
const LinkRevisionDialog = ({ task, onClose }) => {
  const mutation = useChangeMutation();
  const [kind, setKind] = useState("part");
  const [recordId, setRecordId] = useState(null);
  const [revisionId, setRevisionId] = useState(null);
  const [planQ, setPlanSearch] = useDebouncedSearch();
  const [docQ, setDocSearch] = useDebouncedSearch();
  const [fmeaQ, setFmeaSearch] = useDebouncedSearch();
  const plans = useControlPlans({ q: planQ, pageSize: 20 });
  const documents = useDocuments({ q: docQ, status: "draft,active", pageSize: 20 });
  const fmeas = useFmeas({ q: fmeaQ, status: "live", pageSize: 20 }, { enabled: kind === "fmea" });
  const part = usePart(kind === "part" ? recordId : null);
  const plan = useControlPlan(kind === "control_plan" ? recordId : null);
  const document = useDocument(kind === "document" ? recordId : null);
  const fmea = useFmea(kind === "fmea" ? recordId : null);
  const record = { part: part.data, control_plan: plan.data, document: document.data, fmea: fmea.data }[kind];
  const loading = !!recordId && { part, control_plan: plan, document, fmea }[kind].isLoading;
  const options = revisionOptions(kind, record);
  const change = (next) => {
    setKind(next ?? "part");
    setRecordId(null);
    setRevisionId(null);
  };
  const pick = (id) => {
    setRecordId(id);
    setRevisionId(null);
  };
  const save = (e) => {
    e.preventDefault();
    if (!revisionId) return;
    mutation.mutate({ action: "linkTask", id: task.id, body: { link: { kind: TASK_KIND_OF[kind], id: revisionId } } }, { onSuccess: onClose });
  };
  return (
    <Dialog title="Link a revision" onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">Point this task at a revision that already exists. The task can be finished once that revision is in force.</p>
        <ComboField label="What the task changes" required value={kind} onChange={change} options={REVISION_KINDS} sort={false} clearable={false} />
        {kind === "part" && <PartPicker label="Part" value={recordId} onChange={(id) => pick(id)} required />}
        {kind === "control_plan" && (
          <RemoteComboBox label="Control plan" required placeholder="Search a control plan…" value={recordId} onChange={(id) => pick(id)} items={(plans.data?.data ?? []).map(planOption)} isFetching={plans.isFetching} onSearch={setPlanSearch} />
        )}
        {kind === "document" && (
          <RemoteComboBox label="Document" required placeholder="Search a document…" value={recordId} onChange={(id) => pick(id)} items={(documents.data?.data ?? []).map(documentOption)} isFetching={documents.isFetching} onSearch={setDocSearch} />
        )}
        {kind === "fmea" && (
          <RemoteComboBox
            label="FMEA"
            required
            placeholder="Search an FMEA…"
            value={recordId}
            onChange={(id) => pick(id)}
            items={(fmeas.data?.data ?? []).map((f) => ({ id: f.id, name: `${f.number} · ${f.title}`, hint: f.currentLetter ? `Rev ${f.currentLetter}` : "draft" }))}
            isFetching={fmeas.isFetching}
            onSearch={setFmeaSearch}
          />
        )}
        {recordId && (
          <ComboField
            label="Which revision"
            required
            value={revisionId}
            onChange={setRevisionId}
            options={options}
            sort={false}
            placeholder={loading ? "Loading…" : options.length === 0 ? "No revision to choose" : "Choose a revision"}
            disabled={loading || options.length === 0}
            hint={!loading && options.length === 0 ? "It has no draft or revision in force. Use Start a revision to make one." : undefined}
          />
        )}
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!revisionId} label="Link the revision" />
      </form>
    </Dialog>
  );
};

/** The record a task changes: its name, where it stands now, and a link to open it. */
const TaskRecord = ({ link }) => {
  const to = taskLinkPath(link);
  const state = linkStateLabel(link.state);
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-secondary-text">{taskLinkKindLabel(link.kind)}</span>
      {link.readable ? (
        to ? (
          <Link to={to} className="font-medium text-primary-text hover:underline">
            {link.label}
          </Link>
        ) : (
          <span className="font-medium text-primary-text">{link.label}</span>
        )
      ) : (
        <span className="text-secondary-text">a record you cannot open</span>
      )}
      {link.status && <span className="text-xs text-secondary-text">({link.status.replaceAll("_", " ")})</span>}
      {state && <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${linkStatePill(link.state)}`}>{state}</span>}
    </p>
  );
};

const TaskRow = ({ task, onDialog }) => (
  <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="whitespace-pre-wrap text-sm font-medium text-primary-text">{task.description}</p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-secondary-text">
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${taskPill(task.status)}`}>{taskLabel(task.status)}</span>
          <span>{task.owner?.name ?? "Nobody"}</span>
          {task.dueOn && (
            <span className={task.overdue ? "font-medium text-error-color" : undefined}>
              {task.overdue ? "Overdue, was due" : "Due"} {formatDay(task.dueOn)}
            </span>
          )}
          {task.area && <span>{task.area.label}</span>}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {task.canComplete && (
          <CTAButton type="success" icon={CheckIcon} onClick={() => onDialog({ kind: "complete", task })}>
            Done
          </CTAButton>
        )}
        {task.canEdit && !task.link && (
          <CTAButton type="secondary" onClick={() => onDialog({ kind: "revision", task })}>
            Start a revision
          </CTAButton>
        )}
        {task.canEdit && !task.link && (
          <CTAButton type="secondary" onClick={() => onDialog({ kind: "linkRevision", task })} aria-label={`Link a revision to task: ${task.description}`}>
            Link a revision
          </CTAButton>
        )}
        {task.canEdit && (
          <CTAButton type="secondary" icon={PencilIcon} onClick={() => onDialog({ kind: "edit", task })} aria-label={`Change task: ${task.description}`}>
            Change
          </CTAButton>
        )}
        {task.canCancel && (
          <CTAButton type="neutral" icon={XIcon} onClick={() => onDialog({ kind: "cancel", task })} aria-label={`Cancel task: ${task.description}`}>
            Cancel
          </CTAButton>
        )}
        {task.canReopen && (
          <CTAButton type="secondary" icon={RotateCcwIcon} onClick={() => onDialog({ kind: "reopen", task })} aria-label={`Reopen task: ${task.description}`}>
            Reopen
          </CTAButton>
        )}
      </div>
    </div>
    {task.link && <TaskRecord link={task.link} />}
    {task.status === "done" && (
      <p className="text-xs text-secondary-text">
        Done {formatDay(task.doneAt)}
        {task.doneBy ? ` by ${task.doneBy}` : ""}
        {task.resultNote ? ` — ${task.resultNote}` : ""}
      </p>
    )}
    {task.status === "cancelled" && <p className="text-xs text-secondary-text">Cancelled: {task.cancelReason}</p>}
    {task.status === "open" && task.reopenReason && <p className="text-xs text-secondary-text">Reopened: {task.reopenReason}</p>}
  </li>
);

/**
 * The tasks that carry an approved change out. Each can point at the real record it changes (a revision of a part, a control plan or a document), whose
 * live status is shown; the change moves on by itself: implementing while a task is open, then waiting for the effectiveness check.
 */
export const TasksCard = ({ change }) => {
  const [dialog, setDialog] = useState(null);
  const tasks = change.tasks ?? [];
  const show = ["approved", "implementing", "verifying", "closed"].includes(change.stage) || tasks.length > 0;
  if (!show) return null;
  const close = () => setDialog(null);
  return (
    <MenuCard
      title="Tasks"
      subtitle="What has to be done to carry the change out, who does it and by when. A task that changes a revision can be finished once that revision is in force."
      action={
        change.canAddTask && (
          <CTAButton type="secondary" icon={PlusIcon} onClick={() => setDialog({ kind: "add" })}>
            Add a task
          </CTAButton>
        )
      }>
      {tasks.length === 0 ? (
        <Callout tone="info">No tasks yet. Add what has to happen: a new drawing revision, an updated control plan, a revised procedure, training, a message to the supplier.</Callout>
      ) : (
        <ul aria-label="Tasks" className="divide-y divide-border-color">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} onDialog={setDialog} />
          ))}
        </ul>
      )}
      {dialog?.kind === "add" && <TaskDialog change={change} onClose={close} />}
      {dialog?.kind === "edit" && <TaskDialog change={change} existing={dialog.task} onClose={close} />}
      {dialog?.kind === "revision" && <StartRevisionDialog task={dialog.task} onClose={close} />}
      {dialog?.kind === "linkRevision" && <LinkRevisionDialog task={dialog.task} onClose={close} />}
      {dialog?.kind === "complete" && (
        <NoteDialog
          title="Mark as done"
          intro={dialog.task.link ? "The record this task changes has to be in force first." : undefined}
          label="What was done (optional)"
          action="completeTask"
          task={dialog.task}
          submit={(text) => ({ note: text || null })}
          tone="success"
          onClose={close}
        />
      )}
      {dialog?.kind === "cancel" && (
        <NoteDialog title="Cancel the task" label="Why is it cancelled?" required action="cancelTask" task={dialog.task} submit={(text) => ({ reason: text })} tone="danger" onClose={close} />
      )}
      {dialog?.kind === "reopen" && (
        <NoteDialog title="Reopen the task" label="Why is it reopened?" required action="reopenTask" task={dialog.task} submit={(text) => ({ reason: text })} onClose={close} />
      )}
    </MenuCard>
  );
};

/** The effectiveness check: did the change do what it was meant to? Effective closes the change; not effective sends it back to implementing. */
const ReviewDialog = ({ change, onClose }) => {
  const mutation = useChangeMutation();
  const [effective, setEffective] = useState(null);
  const [note, setNote] = useState("");
  const ready = effective !== null && note.trim().length >= 3;
  const send = (e) => {
    e.preventDefault();
    if (!ready) return;
    mutation.mutate({ action: "review", id: change.id, body: { effective, note: note.trim() } }, { onSuccess: onClose });
  };
  return (
    <Dialog title="Check the change worked" onClose={onClose}>
      <form noValidate onSubmit={send} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">Look at what the change was meant to fix. If it worked, the change is closed. If not, it goes back to implementing so a task can put it right.</p>
        <ComboField
          label="Did it work?"
          required
          value={effective === null ? null : effective ? "yes" : "no"}
          onChange={(v) => setEffective(v === "yes")}
          options={[
            { value: "yes", label: "Yes, it is effective", hint: "Closes the change" },
            { value: "no", label: "No, it is not effective", hint: "Back to implementing" },
          ]}
          sort={false}
        />
        <TextAreaField label="What did you check, and what did you find?" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={4} required hint="At least 3 characters" />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label={effective === false ? "Send it back" : "Record the check"} />
      </form>
    </Dialog>
  );
};

/** The check that it worked (once every task is done) and the record of earlier checks. */
export const ReviewCard = ({ change }) => {
  const [open, setOpen] = useState(false);
  const reviews = change.reviews ?? [];
  if (change.stage !== "verifying" && reviews.length === 0) return null;
  return (
    <MenuCard
      title="Effectiveness check"
      subtitle="Every task is done. Check the change did what it was for, then close it."
      action={
        change.canReview && (
          <CTAButton type="main" icon={CheckIcon} onClick={() => setOpen(true)}>
            Record the check
          </CTAButton>
        )
      }>
      {change.stage === "verifying" && change.problems.length > 0 && (
        <div className="mb-3">
          <Callout tone="warning" title="Still in the way of closing it">
            <ul aria-label="Still needed to close" className="list-disc pl-5">
              {change.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Callout>
        </div>
      )}
      {change.stage === "closed" && (
        <div className="mb-3">
          <Callout tone="success" title="Closed">
            Closed {formatDay(change.closedAt)}
            {change.closedBy ? ` by ${change.closedBy}` : ""}.
          </Callout>
        </div>
      )}
      {reviews.length === 0 ? (
        <p className="text-sm text-secondary-text">Not checked yet.</p>
      ) : (
        <ul aria-label="Checks" className="flex flex-col gap-3">
          {reviews.map((r) => (
            <li key={r.id} className="flex flex-col gap-1">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${reviewPill(r.result)}`}>{reviewLabel(r.result)}</span>
                <span className="text-secondary-text">
                  {formatDay(r.reviewedAt)}
                  {r.reviewedBy ? `, ${r.reviewedBy}` : ""}
                </span>
              </p>
              <p className="whitespace-pre-wrap text-sm text-primary-text">{r.note}</p>
            </li>
          ))}
        </ul>
      )}
      {open && <ReviewDialog change={change} onClose={() => setOpen(false)} />}
    </MenuCard>
  );
};

