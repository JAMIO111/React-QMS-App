import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useApprovalDecisions, useAssessmentMutation, useAssessmentTemplates, useSupplierAssessments } from "../../hooks/useSupplierQuality";
import { formatDate } from "../../lib/ncr";
import { formatDateTime } from "../../lib/processControl";
import { ASSESSMENT_STATUS, DECISION_STATUS, RESULT_TONE } from "../../lib/supplierQualification";
import { movesFrom } from "../../lib/supplierQuality";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice, FormError, TextAreaField } from "../master-data/shared";
import { ApprovalPill } from "./SupplierBadges";
import { todayIso } from "@/lib/localDate";


/** Propose approving a supplier (or approving it conditionally). Someone else decides. Without a passing assessment, the reason it is an exception is needed. */
const ProposeDialog = ({ supplier, assessments, onClose }) => {
  const mutation = useAssessmentMutation();
  const targets = movesFrom(supplier.approvalStatus).filter((m) => m === "approved" || m === "conditional");
  const completed = assessments.filter((a) => a.status === "completed");
  const [target, setTarget] = useState(targets[0]);
  const [assessmentId, setAssessmentId] = useState(completed.find((a) => a.result === "pass")?.id ?? completed[0]?.id ?? null);
  const [rationale, setRationale] = useState("");
  const [conditions, setConditions] = useState("");
  const [reviewOn, setReviewOn] = useState("");
  const [exception, setException] = useState("");
  const chosen = completed.find((a) => a.id === assessmentId);
  const needsException = !chosen || (target === "approved" && chosen.result !== "pass");
  const ok = target && rationale.trim().length >= 3 && (target !== "conditional" || conditions.trim()) && (!needsException || exception.trim().length >= 10);

  const submit = (e) => {
    e.preventDefault();
    if (!ok) return;
    mutation.mutate(
      { action: "propose", id: supplier.id, body: { target, rationale: rationale.trim(), ...(assessmentId ? { assessmentId } : {}), ...(target === "conditional" ? { conditions: conditions.trim() } : {}), ...(reviewOn ? { reviewOn } : {}), ...(needsException ? { exceptionReason: exception.trim() } : {}) } },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog title="Propose approval" onClose={onClose} width="max-w-2xl">
      <form noValidate className="flex flex-col gap-3" onSubmit={submit}>
        <p className="text-sm text-secondary-text">A proposal does not change the supplier. Someone else with approval rights reviews it and decides; you cannot approve your own proposal.</p>
        <SlidingToggle ariaLabel="Propose" mode="radio" options={targets.map((t) => ({ value: t, label: t === "approved" ? "Approve" : "Approve conditionally" }))} value={target} onChange={setTarget} />
        <ComboField label="Based on the assessment" value={assessmentId} onChange={setAssessmentId} placeholder="No assessment" options={completed.map((a) => ({ value: a.id, label: `${a.reference} · ${a.templateName}`, hint: `${a.result === "pass" ? "Pass" : "Fail"} · score ${a.score}` }))} hint={completed.length ? undefined : "No completed assessment yet. Start one on this tab, or give an exception reason below."} />
        <TextAreaField label="Rationale" required value={rationale} onChange={(e) => setRationale(e.target.value)} maxLength={1000} rows={3} hint="Why the supplier should be approved. It is kept in the status history." />
        {target === "conditional" && <TextAreaField label="Conditions or restrictions" required value={conditions} onChange={(e) => setConditions(e.target.value)} maxLength={2000} rows={2} hint="What the approval depends on, for example inspect every delivery" />}
        <RHFDatePickerPopout label="Review on" valueFormat="iso" clearable value={reviewOn} onChange={(v) => setReviewOn(v ?? "")} minDate={todayIso(1)} placeholder="No date set" />
        {needsException && (
          <Callout tone="warning" title={chosen ? "The assessment did not pass" : "No assessment is linked"}>
            This approval is an exception and will be marked as one. Say why it should go ahead.
            <Field label="Exception reason" required className="mt-2" value={exception} onChange={(e) => setException(e.target.value)} maxLength={1000} hint="At least 10 characters" />
          </Callout>
        )}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!ok || mutation.isPending} loading={mutation.isPending}>{mutation.isPending ? "Saving…" : "Propose"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const DecideDialog = ({ decision, onClose }) => {
  const mutation = useAssessmentMutation();
  const [approve, setApprove] = useState("approve");
  const [note, setNote] = useState("");
  return (
    <Dialog title="Decide the proposal" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); mutation.mutate({ action: "decide", id: decision.id, body: { approve: approve === "approve", note: note.trim() } }, { onSuccess: onClose }); }}>
        <p className="text-sm text-primary-text">{decision.proposedBy?.name ?? "Someone"} proposed to {decision.target === "approved" ? "approve" : "approve conditionally"} this supplier: {decision.rationale}</p>
        {decision.exceptionReason && <Callout tone="warning" title="Marked as an exception">{decision.exceptionReason}</Callout>}
        <SlidingToggle ariaLabel="Decision" mode="radio" options={[{ value: "approve", label: "Approve" }, { value: "reject", label: "Reject" }]} value={approve} onChange={setApprove} />
        <TextAreaField label="Note" required value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} hint="Why you decided this. It is kept with the decision." />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type={approve === "approve" ? "main" : "danger"} size="lg" disabled={note.trim().length < 3 || mutation.isPending} loading={mutation.isPending}>{mutation.isPending ? "Saving…" : approve === "approve" ? "Approve" : "Reject"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const WithdrawDialog = ({ decision, onClose }) => {
  const mutation = useAssessmentMutation();
  const [reason, setReason] = useState("");
  return (
    <Dialog title="Withdraw the proposal" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); mutation.mutate({ action: "withdraw", id: decision.id, body: { reason: reason.trim() } }, { onSuccess: onClose }); }}>
        <TextAreaField label="Why is it being withdrawn?" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="danger" size="lg" disabled={reason.trim().length < 3 || mutation.isPending} loading={mutation.isPending}>{mutation.isPending ? "Saving…" : "Withdraw"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** How a supplier is approved: the proposal waiting for a decision, who can decide it, and every earlier decision. */
export const ApprovalCard = ({ supplier, canManage, canApprove }) => {
  const decisions = useApprovalDecisions(supplier.id);
  const assessments = useSupplierAssessments(supplier.id);
  const [dialog, setDialog] = useState(null);
  const list = decisions.data?.data ?? [];
  const open = list.find((d) => d.status === "proposed");
  const past = list.filter((d) => d.status !== "proposed");
  const canPropose = canManage && !open && movesFrom(supplier.approvalStatus).some((m) => m === "approved" || m === "conditional");

  return (
    <MenuCard
      title="Approval"
      subtitle="A supplier is approved by one person proposing it and someone else deciding. Suspending or disqualifying stays direct (the Change status button)."
      action={canPropose && <CTAButton buttonType="button" type="secondary" size="default" onClick={() => setDialog({ kind: "propose" })}>Propose approval</CTAButton>}>
      {decisions.error && <ErrorNotice error={decisions.error} />}
      <p className="flex flex-wrap items-center gap-2 text-sm text-primary-text">Status: <ApprovalPill status={supplier.approvalStatus} /></p>
      {open && (
        <Callout tone="warning" role="status" className="mt-3" title={`Proposal waiting for a decision: ${open.target === "approved" ? "approve" : "approve conditionally"}`}
          action={
            <div className="flex gap-2">
              {open.canDecide && <CTAButton buttonType="button" type="main" size="default" onClick={() => setDialog({ kind: "decide", decision: open })}>Decide</CTAButton>}
              {(canApprove || canManage) && <CTAButton buttonType="button" type="neutral" size="default" onClick={() => setDialog({ kind: "withdraw", decision: open })}>Withdraw</CTAButton>}
            </div>
          }>
          <p>{open.rationale}</p>
          <p className="text-xs text-secondary-text">
            Proposed {formatDateTime(open.proposedAt)}{open.proposedBy ? ` by ${open.proposedBy.name}` : ""}
            {open.assessment ? ` · ${open.assessment.reference} (${open.assessment.result === "pass" ? "pass" : "fail"}, ${open.assessment.score})` : ""}
            {open.reviewOn ? ` · review ${formatDate(open.reviewOn)}` : ""}
          </p>
          {open.conditions && <p className="text-xs text-secondary-text">Conditions: {open.conditions}</p>}
          {open.exceptionReason && <p className="text-xs text-warning-color">Exception: {open.exceptionReason}</p>}
          {!open.canDecide && <p className="mt-1 text-xs text-secondary-text">{canApprove ? "You proposed this, so someone else must decide it." : "It needs someone with approval rights, other than the person who proposed it."}</p>}
        </Callout>
      )}
      {past.length > 0 && (
        <details className="mt-3" open={!open}>
          <summary className="cursor-pointer text-sm text-secondary-text">Earlier decisions ({past.length})</summary>
          <ul className="mt-2 flex flex-col gap-2 text-sm" aria-label="Earlier decisions">
            {past.map((d) => (
              <li key={d.id} className="rounded-lg border border-border-color p-2">
                <p className="flex flex-wrap items-center gap-2 text-primary-text">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${DECISION_STATUS[d.status].tone}`}>{DECISION_STATUS[d.status].label}</span>
                  {d.target === "approved" ? "Approval" : "Conditional approval"} · {formatDateTime(d.decidedAt)}{d.decidedBy ? ` by ${d.decidedBy.name}` : ""}
                  {d.exceptionReason && <span className="text-xs text-warning-color">· exception</span>}
                </p>
                <p className="text-secondary-text">Proposed by {d.proposedBy?.name ?? "someone"}: {d.rationale}</p>
                {d.decisionNote && <p className="text-secondary-text">Decision: {d.decisionNote}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!open && past.length === 0 && !decisions.isLoading && <p className="mt-2 text-sm text-secondary-text">No approval has been proposed yet.</p>}
      {dialog?.kind === "propose" && <ProposeDialog supplier={supplier} assessments={assessments.data?.data ?? []} onClose={() => setDialog(null)} />}
      {dialog?.kind === "decide" && <DecideDialog decision={dialog.decision} onClose={() => setDialog(null)} />}
      {dialog?.kind === "withdraw" && <WithdrawDialog decision={dialog.decision} onClose={() => setDialog(null)} />}
    </MenuCard>
  );
};

/** Assessments of a supplier, and starting a new one from an active template. */
export const AssessmentsCard = ({ supplier, canManage, onOpen }) => {
  const query = useSupplierAssessments(supplier.id);
  const templates = useAssessmentTemplates();
  const mutation = useAssessmentMutation();
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState(null);
  const active = useMemo(() => (templates.data?.data ?? []).filter((t) => t.active), [templates.data]);
  const list = query.data?.data ?? [];
  const running = list.find((a) => a.status === "in_progress");
  const chosen = active.find((t) => t.id === (templateId ?? active[0]?.id));

  return (
    <MenuCard
      title="Assessments"
      subtitle="A questionnaire answered about the supplier, scored by the system and frozen when completed."
      action={canManage && !running && active.length > 0 && <CTAButton buttonType="button" type="secondary" size="default" onClick={() => setOpen(true)}>Start assessment</CTAButton>}>
      {query.error && <ErrorNotice error={query.error} />}
      {running && <Callout tone="info" className="mb-3" title={`${running.reference} is in progress`} action={<CTAButton buttonType="button" type="main" size="default" onClick={() => onOpen(running.id)}>Continue</CTAButton>}>Finish or abandon it before starting another.</Callout>}
      {query.isLoading ? <p className="text-sm text-secondary-text">Loading…</p> : list.length === 0 ? <p className="text-sm text-secondary-text">No assessments yet.</p> : (
        <ul className="flex flex-col divide-y divide-border-color" aria-label="Assessments">
          {list.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <Link to={`/Suppliers/${supplier.id}/assessments/${a.id}`} className="font-medium text-link-color hover:underline">{a.reference}</Link>
                <span className="text-sm text-secondary-text"> · {a.templateName} (version {a.templateVersion}) · {formatDateTime(a.startedAt)}</span>
              </div>
              <p className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ASSESSMENT_STATUS[a.status].tone}`}>{ASSESSMENT_STATUS[a.status].label}</span>
                {a.status === "completed" && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RESULT_TONE[a.result]}`}>{a.result === "pass" ? "Pass" : "Fail"} · {a.score}</span>}
              </p>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <Dialog title="Start an assessment" onClose={() => setOpen(false)}>
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); mutation.mutate({ action: "startAssessment", id: supplier.id, body: { templateVersionId: chosen.versionId } }, { onSuccess: (a) => { setOpen(false); onOpen(a.id); } }); }}>
            <ComboField label="Template" required value={chosen?.id ?? null} onChange={setTemplateId} options={active.map((t) => ({ value: t.id, label: t.name, hint: `Version ${t.version} · ${t.questions.length} questions · pass mark ${t.passMark}` }))} />
            <p className="text-sm text-secondary-text">The questions are copied now, so later changes to the template do not alter this assessment.</p>
            <FormError error={mutation.error} />
            <div className="flex justify-end gap-2">
              <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setOpen(false)}>Cancel</CTAButton>
              <CTAButton buttonType="submit" type="main" size="lg" disabled={!chosen || mutation.isPending} loading={mutation.isPending}>{mutation.isPending ? "Starting…" : "Start"}</CTAButton>
            </div>
          </form>
        </Dialog>
      )}
    </MenuCard>
  );
};
