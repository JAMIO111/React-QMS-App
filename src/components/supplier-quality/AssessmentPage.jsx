import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAssessmentMutation, useRespondToAssessment, useSupplierAssessment, useSupplierDocuments } from "../../hooks/useSupplierQuality";
import { usePermissions } from "../../hooks/useQmsApi";
import { formatDateTime } from "../../lib/processControl";
import { DocumentPicker } from "./Qualification";
import { ASSESSMENT_STATUS, RESULT_TONE, expiryBadge } from "../../lib/supplierQualification";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice, FormError, TextAreaField } from "../master-data/shared";

const ANSWERS = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }, { value: "na", label: "Not applicable" }];
const RATINGS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }));
const RESULT_LABEL = { pass: "Pass", fail: "Fail", na: "Not applicable", unscored: "Noted" };

/** One question: the control for its type, a note, and the evidence document where one is required. Each change is saved as it is made. */
const QuestionRow = ({ q, editable, supplierId, documents, onSave }) => {
  const r = q.response;
  const [note, setNote] = useState(r?.note ?? "");
  const chosen = documents.find((d) => d.id === r?.document?.id);
  const chosenExpiry = chosen?.expiry?.state === "expired" || chosen?.expiry?.state === "expiring" ? expiryBadge(chosen.expiry) : null;
  const send = (patch) => onSave({ questionKey: q.key, answer: r?.answer ?? null, rating: r?.rating ?? null, note: note.trim() || null, documentId: r?.document?.id ?? null, ...patch });
  const failing = r?.result === "fail";

  return (
    <li className={`flex flex-col gap-2 rounded-lg border p-3 ${failing ? "border-error-color/50" : "border-border-color"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-primary-text" data-required={q.answerType !== "text" || undefined}>{q.text}</span>
        <span className="text-xs text-secondary-text">
          {q.answerType === "text" ? "Not scored" : `Weight ${q.weight}`}{q.critical ? " · critical" : ""}{q.evidenceRequired ? " · evidence needed" : ""}
          {q.answerType === "rating" ? ` · passes at ${q.passRating}` : ""}
        </span>
      </div>
      {editable ? (
        <>
          {q.answerType === "yes_no" && <SlidingToggle ariaLabel={`${q.text} answer`} mode="radio" options={ANSWERS} value={r?.answer ?? undefined} onChange={(v) => send({ answer: v })} />}
          {q.answerType === "rating" && <SlidingToggle ariaLabel={`${q.text} rating`} mode="radio" options={RATINGS} value={r?.rating ? String(r.rating) : undefined} onChange={(v) => send({ rating: Number(v) })} />}
          <textarea
            aria-label={`Note on ${q.text}`}
            placeholder={failing ? "Say why it fails (needed)" : q.answerType === "text" ? "Your note" : "Note (optional)"}
            value={note}
            rows={q.answerType === "text" ? 3 : 1}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => (note.trim() || null) !== (r?.note ?? null) && (r || q.answerType === "text") && send({})}
            className="rounded-lg border border-border-color bg-text-input-color px-3 min-h-9.5 py-1.5 text-sm text-primary-text focus:outline-none focus:border-brand-primary"
          />
          {q.evidenceRequired && r && r.result !== "na" && (
            <DocumentPicker supplierId={supplierId} documents={documents} label="Evidence" value={r.document?.id ?? null} onChange={(v) => send({ documentId: v })} placeholder="Choose a document" clearable={false} hint="A current document of this supplier, or add a new one here" />
          )}
          {q.evidenceRequired && r && r.result !== "na" && chosenExpiry && (
            <Callout tone="warning" title={chosen.expiry.state === "expired" ? "This document is out of date" : "This document expires soon"}>
              {chosen.title}: {chosenExpiry.label.toLowerCase()}. Ask the supplier for a current one, or choose another document.
            </Callout>
          )}
        </>
      ) : (
        <div className="text-sm text-primary-text">
          {r ? (
            <>
              <p>
                {q.answerType === "yes_no" ? ANSWERS.find((a) => a.value === r.answer)?.label : q.answerType === "rating" ? `Rating ${r.rating}` : null}
                {q.answerType !== "text" && <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${r.result === "pass" ? RESULT_TONE.pass : r.result === "fail" ? RESULT_TONE.fail : "bg-border-color text-secondary-text"}`}>{RESULT_LABEL[r.result]}</span>}
              </p>
              {r.note && <p className="text-secondary-text">{r.note}</p>}
              {r.document && <p className="text-xs text-secondary-text">Evidence: {r.document.title}</p>}
            </>
          ) : (
            <p className="text-secondary-text">Not answered</p>
          )}
        </div>
      )}
    </li>
  );
};

const CompleteDialog = ({ assessment, onClose }) => {
  const mutation = useAssessmentMutation();
  const [summary, setSummary] = useState("");
  const p = assessment.progress;
  return (
    <Dialog title={`Complete ${assessment.reference}`} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); mutation.mutate({ action: "completeAssessment", id: assessment.id, body: summary.trim() ? { summary: summary.trim() } : {} }, { onSuccess: onClose }); }}>
        <Callout tone={p.result === "pass" ? "success" : "warning"} title={`This will score ${p.score} (${p.result === "pass" ? "pass" : "fail"})`}>
          Pass mark {p.passMark}{p.criticalFailures ? `. ${p.criticalFailures} critical question${p.criticalFailures === 1 ? "" : "s"} failed, which fails the assessment whatever the score` : ""}. Once completed it cannot be changed.
        </Callout>
        <TextAreaField label="Summary (optional)" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} rows={3} hint="What the assessor concluded" />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending} loading={mutation.isPending}>{mutation.isPending ? "Saving…" : "Complete assessment"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const AbandonDialog = ({ assessment, onClose, onDone }) => {
  const mutation = useAssessmentMutation();
  const [reason, setReason] = useState("");
  return (
    <Dialog title={`Abandon ${assessment.reference}`} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); mutation.mutate({ action: "abandonAssessment", id: assessment.id, body: { reason: reason.trim() } }, { onSuccess: () => (onClose(), onDone()) }); }}>
        <p className="text-sm text-primary-text">The assessment is kept but can no longer be used. You can start a new one.</p>
        <TextAreaField label="Why is it being abandoned?" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="danger" size="lg" disabled={reason.trim().length < 3 || mutation.isPending} loading={mutation.isPending}>{mutation.isPending ? "Saving…" : "Abandon"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** A supplier assessment (/Suppliers/:supplierId/assessments/:id): answer the frozen questions, see what is still needed and the provisional score, then complete it. */
const AssessmentPage = () => {
  const { supplierId, id } = useParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const query = useSupplierAssessment(id);
  useBreadcrumbNames([
    { path: `/Suppliers/${supplierId}`, label: query.data ? query.data.supplier.name : null },
    { path: `/Suppliers/${supplierId}/assessments`, to: `/Suppliers/${supplierId}?tab=qualification` },
    { path: `/Suppliers/${supplierId}/assessments/${id}`, label: query.data?.reference },
  ]);
  const documents = useSupplierDocuments(supplierId);
  const mutation = useAssessmentMutation();
  const respond = useRespondToAssessment(id);
  const [dialog, setDialog] = useState(null);
  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <div className="p-4"><ErrorNotice error={query.error} /></div>;
  const a = query.data;
  const editable = a.status === "in_progress" && can("supplier_quality.manage");
  const sections = [...new Set(a.questions.map((q) => q.section || "Questions"))];
  const p = a.progress;
  const status = ASSESSMENT_STATUS[a.status];
  const back = `/Suppliers/${a.supplier.id}?tab=qualification`;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Breadcrumb />
          <h1 className="text-2xl font-semibold text-primary-text">{a.reference} · {a.templateName}</h1>
          <p className="flex flex-wrap items-center gap-2 text-sm text-secondary-text">
            <Link to={back} className="text-link-color hover:underline">{a.supplier.code} · {a.supplier.name}</Link>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>
            <span>Template version {a.templateVersion} · pass mark {a.passMark}</span>
            <span>Started {formatDateTime(a.startedAt)}{a.startedBy ? ` by ${a.startedBy.name}` : ""}</span>
          </p>
        </div>
        {editable && (
          <div className="flex gap-2">
            <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setDialog("abandon")}>Abandon</CTAButton>
            <CTAButton buttonType="button" type="main" size="lg" disabled={p.problems.length > 0} onClick={() => setDialog("complete")}>Complete</CTAButton>
          </div>
        )}
      </div>

      {a.status === "completed" && (
        <Callout tone={a.result === "pass" ? "success" : "error"} role="status" title={`${a.result === "pass" ? "Passed" : "Failed"} with a score of ${a.score}`}>
          Pass mark {a.passMark}{a.criticalFailures ? ` · ${a.criticalFailures} critical question${a.criticalFailures === 1 ? "" : "s"} failed` : ""}. Completed {formatDateTime(a.completedAt)}{a.completedBy ? ` by ${a.completedBy.name}` : ""}.{a.summary ? ` ${a.summary}` : ""}
        </Callout>
      )}
      {a.status === "abandoned" && <Callout tone="info" role="status" title="Abandoned">{a.abandonReason}</Callout>}
      {a.status === "in_progress" && (
        <Callout tone={p.problems.length ? "warning" : "success"} role="status" title={p.problems.length ? `${p.answered} of ${p.scored} scored questions answered` : "Everything is answered"} >
          {p.problems.length ? (
            <ul className="mt-1 list-disc pl-5" aria-label="Still needed">{p.problems.slice(0, 6).map((x) => <li key={x}>{x}</li>)}{p.problems.length > 6 && <li>and {p.problems.length - 6} more</li>}</ul>
          ) : (
            <>It would score {p.score} ({p.result}) against a pass mark of {p.passMark}.</>
          )}
        </Callout>
      )}
      <FormError error={mutation.error} />

      {sections.map((sec) => (
        <MenuCard key={sec} title={sec}>
          <ul className="flex flex-col gap-3" aria-label={sec}>
            {a.questions.filter((q) => (q.section || "Questions") === sec).map((q) => (
              <QuestionRow key={q.key} supplierId={supplierId} q={q} editable={editable} documents={documents.data?.data ?? []} onSave={(body) => respond({ body, documents: documents.data?.data ?? [] })} />
            ))}
          </ul>
        </MenuCard>
      ))}
      {dialog === "complete" && <CompleteDialog assessment={a} onClose={() => setDialog(null)} />}
      {dialog === "abandon" && <AbandonDialog assessment={a} onClose={() => setDialog(null)} onDone={() => navigate(back)} />}
    </div>
  );
};

export default AssessmentPage;
