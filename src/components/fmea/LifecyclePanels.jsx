import { useState } from "react";
import { Link } from "react-router-dom";
import CTAButton from "@/components/CTAButton";
import { ClipboardCheckIcon, PlusIcon } from "@/components/icons";
import { useFmeaBaseChanges, useFmeaCompare, useFmeaMutation } from "../../hooks/useFmea";
import { compareKindLabel, compareValue, fieldLabel, fmeaPath, formatDay, REVIEW_OUTCOME, revisionName } from "../../lib/fmea";
import { FormError, TextAreaField } from "../master-data/shared";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";

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

/** Start a revision, and choose whether it takes in the finished actions of the revision in force: their words join the controls, their revised ratings become the causes' ratings. */
export const StartRevisionDialog = ({ fmea, onClose, onStarted }) => {
  const mutation = useFmeaMutation();
  const [adopt, setAdopt] = useState("yes");
  const n = fmea.adoptableActions;
  const send = (e) => {
    e.preventDefault();
    mutation.mutate({ action: "startRevision", id: fmea.id, body: { adopt: adopt === "yes" } }, { onSuccess: (updated) => { onClose(); onStarted?.(updated); } });
  };
  return (
    <Dialog title="Start a new revision" onClose={onClose} width="max-w-xl">
      <form noValidate onSubmit={send} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">
          The new revision starts as a copy of the one in force. {n} finished {n === 1 ? "action has" : "actions have"} not been taken into the analysis yet.
        </p>
        <SlidingToggle
          ariaLabel="Finished actions"
          mode="radio"
          value={adopt}
          onChange={setAdopt}
          options={[
            { value: "yes", label: `Take the ${n === 1 ? "action" : n + " actions"} in` },
            { value: "no", label: "Start without them" },
          ]}
        />
        <p className="text-sm text-secondary-text">
          {adopt === "yes"
            ? "What each action did is added to the cause's prevention or detection controls, and the occurrence and detection it came to become the cause's ratings, which are scored again. You can change all of it while the revision is a draft."
            : "The causes keep the ratings they have. The finished actions stay on the revision in force."}
        </p>
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} label="Start the revision" />
      </form>
    </Dialog>
  );
};

/** Record the periodic review: nothing needs changing (and why), or a revision is started. */
export const ReviewDialog = ({ fmea, onClose, onStarted }) => {
  const mutation = useFmeaMutation();
  const [outcome, setOutcome] = useState("no_change");
  const [note, setNote] = useState("");
  const ready = outcome === "revision_started" || note.trim().length >= 3;
  const send = (e) => {
    e.preventDefault();
    if (!ready) return;
    mutation.mutate(
      { action: "review", id: fmea.id, body: { outcome, ...(note.trim() ? { note: note.trim() } : {}) } },
      { onSuccess: (updated) => { onClose(); if (outcome === "revision_started") onStarted?.(updated); } },
    );
  };
  return (
    <Dialog title="Record a review" onClose={onClose} width="max-w-xl">
      <form noValidate onSubmit={send} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">Check that the analysis still reflects the design or the process: the failure history, the controls, what has changed since it was approved.</p>
        <SlidingToggle
          ariaLabel="Outcome of the review"
          mode="radio"
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: "no_change", label: "No change needed" },
            { value: "revision_started", label: "Start a revision" },
          ]}
        />
        {outcome === "no_change" ? (
          <TextAreaField label="What you checked" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} required hint="This is kept with the review, and the next review moves a full interval away" />
        ) : (
          <p className="text-sm text-secondary-text">A new draft is started from the revision in force. The review is recorded now; the next review date moves when the new revision is approved.</p>
        )}
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label={outcome === "no_change" ? "Record the review" : "Record and start a revision"} />
      </form>
    </Dialog>
  );
};

/** The reviews so far, when the next one is due, and the button to record one. */
export const ReviewsCard = ({ fmea, onStarted }) => {
  const [open, setOpen] = useState(false);
  if (fmea.status !== "active" && fmea.reviews.length === 0) return null;
  return (
    <MenuCard
      title="Reviews"
      subtitle={fmea.nextReviewOn ? `Next review ${formatDay(fmea.nextReviewOn)}${fmea.reviewOverdue ? " (overdue)" : ""}` : "An FMEA is reviewed on a schedule, and when something changes."}
      action={
        fmea.canReview && (
          <CTAButton type="secondary" icon={ClipboardCheckIcon} onClick={() => setOpen(true)}>
            Record a review
          </CTAButton>
        )
      }>
      {fmea.reviews.length === 0 ? (
        <p className="text-sm text-secondary-text">No review has been recorded yet.</p>
      ) : (
        <ul aria-label="Reviews" className="flex flex-col gap-2">
          {fmea.reviews.map((r) => (
            <li key={r.id} className="rounded-xl border border-border-color bg-primary-bg px-3 py-2 text-sm">
              <p className="font-medium text-primary-text">
                {REVIEW_OUTCOME[r.outcome]} <span className="font-normal text-secondary-text">· {formatDay(r.at)}{r.by ? ` · ${r.by.name}` : ""}</span>
              </p>
              {r.note && <p className="text-secondary-text">{r.note}</p>}
              {r.outcome === "revision_started" && r.startedLetter == null && <p className="text-secondary-text">A revision was started.</p>}
            </li>
          ))}
        </ul>
      )}
      {open && <ReviewDialog fmea={fmea} onClose={() => setOpen(false)} onStarted={onStarted} />}
    </MenuCard>
  );
};

/** One line of a comparison: what it is, where it sits, and for a changed row each field with what it was. */
const ChangeLine = ({ change }) => (
  <li className="rounded-xl border border-border-color bg-primary-bg px-3 py-2 text-sm">
    <p className="text-primary-text">
      <span
        className={`mr-2 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
          change.change === "added" ? "bg-success-color/15 text-success-color" : change.change === "removed" ? "bg-error-color/15 text-error-color" : "bg-warning-color/15 text-warning-color"
        }`}>
        {change.change === "added" ? "Added" : change.change === "removed" ? "Removed" : "Changed"}
      </span>
      <span className="text-secondary-text">{compareKindLabel(change.kind)} </span>
      <span className="font-medium">{change.label}</span>
    </p>
    {change.path.length > 0 && <p className="text-xs text-secondary-text">{change.path.join(" › ")}</p>}
    {change.fields.length > 0 && (
      <ul className="mt-1 flex flex-col gap-0.5 text-xs">
        {change.fields.map((f) => (
          <li key={f.field} className="text-secondary-text">
            {fieldLabel(f.field)}: <span className="text-primary-text line-through decoration-secondary-text/60">{compareValue(f.field, f.from)}</span> → <span className="text-primary-text">{compareValue(f.field, f.to)}</span>
          </li>
        ))}
      </ul>
    )}
  </li>
);

const counts = (c) => `${c.added} added · ${c.removed} removed · ${c.changed} changed · ${c.same} unchanged`;

/** What changed since the revision before this one, row by row. Read on request. */
export const CompareCard = ({ revision }) => {
  const [open, setOpen] = useState(false);
  const query = useFmeaCompare(revision.id, undefined, { enabled: open && !!revision.previousRevisionId });
  if (!revision.previousRevisionId || revision.status === "discarded") return null;
  const diff = query.data;
  return (
    <MenuCard
      title="What changed since the last revision"
      subtitle="Row by row, matched by where each row came from, never by its wording."
      action={
        <CTAButton type="secondary" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show what changed"}
        </CTAButton>
      }>
      {open && query.isLoading && <p className="text-sm text-secondary-text">Comparing…</p>}
      {open && query.error && <FormError error={query.error} />}
      {open && diff?.comparable && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-secondary-text" aria-label="Comparison figures">
            {revisionName(diff.newer)} against {revisionName(diff.older)}: {counts(diff.counts)}
          </p>
          {diff.changes.length === 0 ? <p className="text-sm text-secondary-text">Nothing has changed.</p> : <ul aria-label="Changes" className="flex flex-col gap-2">{diff.changes.map((c) => <ChangeLine key={`${c.change}-${c.rowId}`} change={c} />)}</ul>}
        </div>
      )}
      {open && diff && !diff.comparable && <p className="text-sm text-secondary-text">{diff.reason}</p>}
    </MenuCard>
  );
};

/** For an FMEA started from a base: tells the team when the base has changed since it was copied, and lists what changed. The copy is its own; nothing is brought across by itself. */
export const BaseChangesCallout = ({ revision }) => {
  const live = !!revision.base?.fmeaId && ["draft", "effective"].includes(revision.status);
  const query = useFmeaBaseChanges(revision.id, { enabled: live });
  const [open, setOpen] = useState(false);
  const data = query.data;
  if (!live || !data?.hasBase || !data.readable || !data.moved) return null;
  return (
    <Callout tone="info" title="The base has moved on">
      <p>
        <Link to={fmeaPath(data.base.fmeaId)} className="underline">
          {data.base.number}
        </Link>{" "}
        ({data.base.title}) is now at rev {data.base.currentLetter}; this analysis was copied from rev {data.base.copiedLetter}. {counts(data.counts)}. Nothing is changed here by itself: look at what
        changed and bring across what applies.
      </p>
      <div className="mt-2">
        <CTAButton type="secondary" icon={PlusIcon} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide what changed in the base" : "Show what changed in the base"}
        </CTAButton>
      </div>
      {open && (data.changes.length === 0 ? <p className="mt-2">Nothing in the analysis itself has changed.</p> : <ul aria-label="Changes in the base" className="mt-2 flex flex-col gap-2">{data.changes.map((c) => <ChangeLine key={`${c.change}-${c.rowId}`} change={c} />)}</ul>)}
    </Callout>
  );
};
