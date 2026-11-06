import { useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import { useInspectionMutation, useNcrDraft } from "../../hooks/useInspection";
import { formatDateTime } from "../../lib/processControl";
import { describeLimits } from "../../lib/inspection";
import { buttonClass, ErrorNotice, FormError, SelectField, TextAreaField } from "../master-data/shared";

const SEVERITIES = [
  { value: "critical", label: "Critical" },
  { value: "major", label: "Major" },
  { value: "minor", label: "Minor" },
];
const inputClass =
  "rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-primary-text hover:border-border-dark-color focus:outline-none focus:border-brand-primary disabled:opacity-60";

const readingText = (m, requirement) =>
  requirement.dataType === "attribute" ? (m.valuePass ? "Pass" : "Fail") : `${m.valueNumeric}${m.unitCode ? ` ${m.unitCode}` : ""}`;

/** What the failed reading still needs: nothing (handled), or a person's attention. */
const handled = (m) => !!m.acknowledgement || m.ncrs.length > 0;

/** The failed readings still standing (not replaced by a correction). */
export const currentFailures = (inspection) => inspection.measurements.filter((m) => m.result === "fail" && !m.supersededById);

const AcknowledgeDialog = ({ reading, requirement, onClose }) => {
  const mutation = useInspectionMutation();
  const [note, setNote] = useState("");
  return (
    <Dialog title={`Acknowledge failed reading — ${requirement.name}`} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({ path: `/inspection-measurements/${reading.id}/acknowledge`, body: { note } }, { onSuccess: onClose });
        }}>
        <p className="text-sm text-primary-text">
          Reading {readingText(reading, requirement)} is outside {describeLimits(requirement)}. Say what is being done about it; this is recorded with your name and the time.
        </p>
        <TextAreaField label="What is being done" value={note} onChange={(e) => setNote(e.target.value)} required maxLength={1000} rows={3} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.neutral} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={buttonClass.primary} disabled={!note.trim() || mutation.isPending}>
            Acknowledge
          </button>
        </div>
      </form>
    </Dialog>
  );
};

/** The pre-filled NC for the chosen readings; every field can be edited before it is raised. */
const NcFields = ({ inspection, draft, measurementIds, onClose }) => {
  const mutation = useInspectionMutation();
  const navigate = useNavigate();
  const id = useId();
  const [title, setTitle] = useState(draft.title);
  const [description, setDescription] = useState(draft.description);
  const [severity, setSeverity] = useState(draft.severity);
  const [quantity, setQuantity] = useState(draft.quantityAffected ?? "");
  const [open, setOpen] = useState(false);
  const linked = draft.readings.filter((r) => r.alreadyLinked.length > 0);

  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      {
        path: `/inspections/${inspection.id}/raise-ncr`,
        body: {
          measurementIds,
          title,
          description,
          severity,
          quantityAffected: quantity === "" ? null : Number(quantity),
          requirement: draft.requirement || undefined,
          actualResult: draft.actualResult || undefined,
          open,
        },
      },
      { onSuccess: (data) => (onClose(), navigate(`/Non-Conformance/Internal/${data.ncr.id}`)) }
    );
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      {draft.readings.length > 0 && (
        <ul className="text-sm text-primary-text" aria-label="Readings this NC covers">
          {draft.readings.map((r) => (
            <li key={r.id}>
              {r.requirementName}, sample #{r.sampleNumber}: <span className="tabular-nums">{r.value}</span> (limits {r.limits})
            </li>
          ))}
        </ul>
      )}
      {linked.length > 0 && (
        <p role="note" className="rounded-lg border border-border-color p-2 text-sm text-primary-text">
          Already linked to {[...new Set(linked.flatMap((r) => r.alreadyLinked.map((n) => n.reference)))].join(", ")}. Raising another is allowed, but check it is not a duplicate.
        </p>
      )}
      {draft.containment.length > 0 && (
        <div className="text-sm text-primary-text">
          <p className="font-medium text-secondary-text">Containment window (suspect product)</p>
          <ul>
            {draft.containment.map((c) => (
              <li key={c.name}>
                {c.name}: {c.lastGood ? `last good sample #${c.lastGood.sampleNumber} at ${formatDateTime(c.lastGood.measuredAt)}` : "no earlier good reading in this inspection"}; first failure sample #
                {c.firstFailure.sampleNumber} at {formatDateTime(c.firstFailure.measuredAt)}.
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-title`} className="text-sm font-medium text-secondary-text">
          Title
        </label>
        <input id={`${id}-title`} className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
      </div>
      <TextAreaField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={10000} rows={8} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SelectField label="Severity" value={severity} onChange={setSeverity} options={SEVERITIES} hint="Needed to open" />
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-qty`} className="text-sm font-medium text-secondary-text">
            Quantity affected
          </label>
          <input id={`${id}-qty`} type="number" min="0" step="any" className={inputClass} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-primary-text">
        <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} disabled={!severity || quantity === ""} />
        Open the NC now (otherwise it starts as a draft)
      </label>
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass.neutral} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className={buttonClass.primary} disabled={!title.trim() || mutation.isPending}>
          Raise non-conformance
        </button>
      </div>
    </form>
  );
};

const RaiseDialog = ({ inspection, measurementIds, onClose }) => {
  const draft = useNcrDraft(inspection.id, measurementIds);
  return (
    <Dialog title={measurementIds.length ? "Raise non-conformance for failed readings" : "Raise non-conformance for this inspection"} onClose={onClose} width="max-w-2xl">
      {draft.isLoading && <p className="text-sm text-secondary-text">Preparing the non-conformance…</p>}
      {draft.error && <ErrorNotice error={draft.error} />}
      {draft.data && <NcFields inspection={inspection} draft={draft.data} measurementIds={measurementIds} onClose={onClose} />}
    </Dialog>
  );
};

/**
 * Failed readings that need a person: read the reaction plan, acknowledge, or raise an NC. A
 * completed-inspection rule in the database requires every failure to be acknowledged or have an NC.
 */
const Failures = ({ inspection, canRecord, canRaise }) => {
  const failures = currentFailures(inspection);
  const [picked, setPicked] = useState([]);
  const [ack, setAck] = useState(null);
  const [raising, setRaising] = useState(null); // measurement id list
  const byRequirement = Object.fromEntries(inspection.requirements.map((q) => [q.id, q]));
  const sampleNo = Object.fromEntries(inspection.samples.map((s) => [s.id, s.sampleNumber]));
  const open = inspection.status === "in_progress";
  const unhandled = failures.filter((m) => !handled(m));

  if (failures.length === 0 && !(canRaise && open) && inspection.ncrs.length === 0) return null;

  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <MenuCard
      title="Failures and non-conformances"
      subtitle={
        unhandled.length
          ? `${unhandled.length} failed reading${unhandled.length > 1 ? "s" : ""} still need${unhandled.length > 1 ? "" : "s"} an acknowledgement or a non-conformance before the inspection can be completed.`
          : "Every failed reading has been handled."
      }
      action={
        canRaise && (open || inspection.status === "completed") ? (
          <button type="button" className={buttonClass.neutral} onClick={() => setRaising([])}>
            Raise NC without a reading
          </button>
        ) : null
      }>
      {inspection.ncrs.length > 0 && (
        <p className="mb-3 text-sm text-primary-text">
          Non-conformances raised:{" "}
          {inspection.ncrs.map((n, i) => (
            <span key={n.id}>
              {i > 0 && ", "}
              <Link className="text-link-color hover:underline" to={`/Non-Conformance/Internal/${n.id}`}>
                {n.reference}
              </Link>{" "}
              ({n.stage})
            </span>
          ))}
        </p>
      )}
      {failures.length > 0 && (
        <ul className="flex flex-col gap-3" aria-label="Failed readings">
          {failures.map((m) => {
            const q = byRequirement[m.requirementId];
            const instructions = q.reactions.filter((r) => r.instruction);
            return (
              <li key={m.id} className="rounded-lg border border-border-color p-3 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  {canRaise && (
                    <input type="checkbox" aria-label={`Select ${q.name} sample ${sampleNo[m.sampleId]} for a non-conformance`} checked={picked.includes(m.id)} onChange={() => toggle(m.id)} />
                  )}
                  <span className="font-medium text-primary-text">{q.name}</span>
                  <span className="text-secondary-text">sample #{sampleNo[m.sampleId]}</span>
                  <span className="tabular-nums text-error-color">{readingText(m, q)}</span>
                  <span className="text-secondary-text">{describeLimits(q)}</span>
                </div>
                {instructions.length > 0 && (
                  <div className="mt-2 text-primary-text">
                    <p className="text-secondary-text">Reaction plan</p>
                    <ul className="list-disc pl-5">
                      {instructions.map((r, i) => (
                        <li key={i}>{r.instruction}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {m.acknowledgement && (
                    <span className="text-primary-text">
                      Acknowledged by {m.acknowledgement.by?.name ?? "someone"} on {formatDateTime(m.acknowledgement.at)}: “{m.acknowledgement.note}”
                    </span>
                  )}
                  {m.ncrs.map((n) => (
                    <Link key={n.id} className="rounded-full bg-border-color px-2 py-0.5 text-xs text-primary-text hover:underline" to={`/Non-Conformance/Internal/${n.id}`}>
                      {n.reference}
                    </Link>
                  ))}
                  {open && canRecord && !m.acknowledgement && (
                    <button type="button" className={buttonClass.neutral} onClick={() => setAck(m)}>
                      Acknowledge
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {canRaise && picked.length > 0 && (
        <div className="mt-3">
          <button type="button" className={buttonClass.primary} onClick={() => setRaising(picked)}>
            Raise NC for {picked.length} selected reading{picked.length > 1 ? "s" : ""}
          </button>
        </div>
      )}
      {ack && <AcknowledgeDialog reading={ack} requirement={byRequirement[ack.requirementId]} onClose={() => setAck(null)} />}
      {raising && (
        <RaiseDialog
          inspection={inspection}
          measurementIds={raising}
          onClose={() => {
            setRaising(null);
            setPicked([]);
          }}
        />
      )}
    </MenuCard>
  );
};

export default Failures;
