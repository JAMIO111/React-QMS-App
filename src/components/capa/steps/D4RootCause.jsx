import { useState } from "react";
import Dialog from "../../ui/Dialog";
import Field from "../../ui/Field";
import MenuCard from "../../ui/MenuCard";
import RHFComboBox from "../../ui/RHFComboBox";
import { useCapaMutation } from "../../../hooks/useCapa";
import { ROOT_CAUSE_KINDS, ROOT_CAUSE_OPTIONS } from "../../../lib/capa";
import { formatDay } from "../../../lib/qualityAlerts";
import { FormError, TextAreaField, buttonClass } from "../../master-data/shared";
import FiveWhysDialog from "../FiveWhysDialog";
import IshikawaDialog from "../IshikawaDialog";

const CauseDialog = ({ capa, cause, onClose }) => {
  const mutation = useCapaMutation();
  const [form, setForm] = useState({ kind: cause?.kind ?? "occurrence", description: cause?.description ?? "" });
  return (
    <Dialog title={cause ? "Edit root cause" : "Add a root cause"} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const body = { kind: form.kind, description: form.description.trim() };
          mutation.mutate(cause ? { action: "updateRootCause", id: cause.id, body } : { action: "addRootCause", id: capa.id, body }, { onSuccess: onClose });
        }}>
        <RHFComboBox label="Kind" required value={form.kind} onChange={(v) => setForm((f) => ({ ...f, kind: v ?? "occurrence" }))} options={ROOT_CAUSE_OPTIONS} sort={false} clearable={false} hint={ROOT_CAUSE_KINDS[form.kind].help} />
        <TextAreaField label="The root cause" required value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} maxLength={2000} hint="A cause you can verify and fix, not a symptom" />
        {cause?.verified && <p className="text-sm text-warning-color">Changing the words or the kind withdraws its verification, so it has to be verified again.</p>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.neutral} onClick={onClose}>Cancel</button>
          <button type="submit" className={buttonClass.primary} disabled={mutation.isPending || !form.description.trim()}>{mutation.isPending ? "Saving…" : cause ? "Save" : "Add root cause"}</button>
        </div>
      </form>
    </Dialog>
  );
};

const VerifyDialog = ({ cause, onClose }) => {
  const mutation = useCapaMutation();
  const [method, setMethod] = useState(cause.verificationMethod ?? "");
  const [note, setNote] = useState(cause.verificationNote ?? "");
  return (
    <Dialog title={cause.verified ? "Verification" : "Verify the root cause"} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({ action: "updateRootCause", id: cause.id, body: { verified: true, verificationMethod: method.trim(), verificationNote: note.trim() || null } }, { onSuccess: onClose });
        }}>
        <p className="text-sm text-primary-text">{cause.description}</p>
        <p className="text-sm text-secondary-text">A cause is verified when you have shown it produces the problem and that removing it stops the problem: a trial, a test, a measurement, or reproducing it.</p>
        <Field label="How was it verified?" required value={method} onChange={(e) => setMethod(e.target.value)} maxLength={200} placeholder="e.g. Trial with a new tool on three lots" />
        <TextAreaField label="What was found (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.neutral} onClick={onClose}>Cancel</button>
          <button type="submit" className={buttonClass.primary} disabled={mutation.isPending || !method.trim()}>{mutation.isPending ? "Saving…" : cause.verified ? "Save verification" : "Mark as verified"}</button>
        </div>
      </form>
    </Dialog>
  );
};

const ConfirmRemove = ({ title, text, pending, error, onConfirm, onClose }) => (
  <Dialog title={title} onClose={onClose}>
    <div className="flex flex-col gap-3">
      <p className="text-sm text-primary-text">{text}</p>
      <FormError error={error} />
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass.neutral} onClick={onClose}>Keep it</button>
        <button type="button" className={buttonClass.danger} disabled={pending} onClick={onConfirm}>{pending ? "Removing…" : "Remove"}</button>
      </div>
    </div>
  </Dialog>
);

const summary = (a) => {
  if (a.kind === "ishikawa") {
    const causes = (a.data.categories ?? []).flatMap((c) => c.causes ?? []);
    return `${causes.length} ${causes.length === 1 ? "cause" : "causes"}, ${causes.filter((c) => c.probable).length} probable`;
  }
  const n = (a.data.whys ?? []).length;
  return `${n} ${n === 1 ? "why" : "whys"}${a.data.rootCause ? ` → ${a.data.rootCause}` : ""}`;
};

/**
 * D4: why it happened, why it escaped, and why the system allowed it. Causes are verified before anyone acts on them. The Ishikawa diagram and
 * 5 Whys open as modals and can feed their conclusions into the list of root causes.
 */
const D4RootCause = ({ capa, editable }) => {
  const mutation = useCapaMutation();
  const [dialog, setDialog] = useState(null); // { type: "cause" | "verify" | "fishbone" | "whys" | "remove-cause" | "remove-analysis", cause?, analysis? }
  const close = () => setDialog(null);
  const tools = capa.analyses.filter((a) => a.kind === "ishikawa" || a.kind === "five_whys");
  const hasEscape = capa.rootCauses.some((c) => c.kind === "escape");
  const analysisTitle = (id) => capa.analyses.find((a) => a.id === id)?.title;

  return (
    <div className="flex flex-col gap-4">
      <MenuCard title="Root causes" subtitle={`${capa.rootCauses.filter((c) => c.verified).length} of ${capa.rootCauses.length} verified`}
        action={editable ? <button type="button" className={buttonClass.neutral} onClick={() => { mutation.reset(); setDialog({ type: "cause" }); }}>Add a root cause</button> : undefined}>
        {capa.rootCauses.length === 0 ? (
          <p className="text-sm text-secondary-text">No root cause yet. Use the Ishikawa diagram or 5 Whys below to find it, then record it here and verify it.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-color" aria-label="Root causes">
            {capa.rootCauses.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 py-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="max-w-3xl text-primary-text">{c.description}</p>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ROOT_CAUSE_KINDS[c.kind].tone}`}>{ROOT_CAUSE_KINDS[c.kind].label}</span>
                </div>
                {c.sourceAnalysisId && analysisTitle(c.sourceAnalysisId) && <p className="text-xs text-secondary-text">From {analysisTitle(c.sourceAnalysisId)}</p>}
                {c.verified ? (
                  <p className="text-xs text-primary-text">
                    <span className="font-medium text-success-color">Verified</span> by {c.verifiedBy?.name ?? "someone"} on {formatDay(c.verifiedAt.slice(0, 10))}: {c.verificationMethod}
                    {c.verificationNote && <span className="text-secondary-text"> — {c.verificationNote}</span>}
                  </p>
                ) : (
                  <p className="text-xs font-medium text-warning-color">Not verified yet</p>
                )}
                {editable && (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={c.verified ? buttonClass.neutral : buttonClass.primary} aria-label={`${c.verified ? "Edit verification of" : "Verify"}: ${c.description}`} onClick={() => { mutation.reset(); setDialog({ type: "verify", cause: c }); }}>{c.verified ? "Edit verification" : "Verify"}</button>
                    <button type="button" className={buttonClass.neutral} aria-label={`Edit: ${c.description}`} onClick={() => { mutation.reset(); setDialog({ type: "cause", cause: c }); }}>Edit</button>
                    {c.verified && <button type="button" className={buttonClass.neutral} aria-label={`Withdraw verification of: ${c.description}`} disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "updateRootCause", id: c.id, body: { verified: false } })}>Withdraw verification</button>}
                    <button type="button" className={buttonClass.neutral} aria-label={`Remove: ${c.description}`} onClick={() => { mutation.reset(); setDialog({ type: "remove-cause", cause: c }); }}>Remove</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {capa.rootCauses.length > 0 && !hasEscape && <p className="mt-3 text-xs text-secondary-text">Also record why it escaped detection (an escape cause). It is advised, not required.</p>}
        <FormError error={dialog ? null : mutation.error} />
      </MenuCard>

      <MenuCard title="Analysis tools" subtitle="Find the causes, then record and verify them above"
        action={editable ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass.neutral} onClick={() => setDialog({ type: "fishbone" })}>New Ishikawa diagram</button>
            <button type="button" className={buttonClass.neutral} onClick={() => setDialog({ type: "whys" })}>New 5 Whys</button>
          </div>
        ) : undefined}>
        {tools.length === 0 ? (
          <p className="text-sm text-secondary-text">No analysis yet. An Ishikawa diagram lists everything that could cause the problem; 5 Whys follows one cause down to its root.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-color" aria-label="Analyses">
            {tools.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium text-primary-text">{a.title} <span className="font-normal text-secondary-text">· {a.kind === "ishikawa" ? "Ishikawa" : "5 Whys"}</span></span>
                  <span className="truncate text-xs text-secondary-text">{summary(a)}</span>
                </div>
                <div className="flex gap-2">
                  <button type="button" className={buttonClass.neutral} aria-label={`${editable ? "Open" : "View"} ${a.title}`} onClick={() => setDialog({ type: a.kind === "ishikawa" ? "fishbone" : "whys", analysis: a })}>{editable ? "Open" : "View"}</button>
                  {editable && <button type="button" className={buttonClass.neutral} aria-label={`Remove ${a.title}`} onClick={() => { mutation.reset(); setDialog({ type: "remove-analysis", analysis: a }); }}>Remove</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </MenuCard>

      {dialog?.type === "cause" && <CauseDialog capa={capa} cause={dialog.cause} onClose={close} />}
      {dialog?.type === "verify" && <VerifyDialog cause={dialog.cause} onClose={close} />}
      {dialog?.type === "fishbone" && <IshikawaDialog capa={capa} analysis={dialog.analysis} onClose={close} />}
      {dialog?.type === "whys" && <FiveWhysDialog capa={capa} analysis={dialog.analysis} onClose={close} />}
      {dialog?.type === "remove-cause" && (
        <ConfirmRemove title="Remove this root cause?" text={dialog.cause.description} pending={mutation.isPending} error={mutation.error} onClose={close}
          onConfirm={() => mutation.mutate({ action: "removeRootCause", id: dialog.cause.id }, { onSuccess: close })} />
      )}
      {dialog?.type === "remove-analysis" && (
        <ConfirmRemove title={`Remove ${dialog.analysis.title}?`} text="The analysis is removed from this 8D. Root causes recorded from it stay." pending={mutation.isPending} error={mutation.error} onClose={close}
          onConfirm={() => mutation.mutate({ action: "removeAnalysis", id: dialog.analysis.id }, { onSuccess: close })} />
      )}
    </div>
  );
};

export default D4RootCause;
