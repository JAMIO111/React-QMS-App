import { useState } from "react";
import Dialog from "../../ui/Dialog";
import Field from "../../ui/Field";
import MenuCard from "../../ui/MenuCard";
import ReasonDialog from "../../ncr/ReasonDialog";
import { useCapaMutation } from "../../../hooks/useCapa";
import { DIMENSIONS, FIVE_W2H, IS_IS_NOT_ROWS } from "../../../lib/capa";
import { FormError, TextAreaField } from "../../master-data/shared";
import CTAButton from "@/components/CTAButton";

const FiveW2HDialog = ({ capa, onClose }) => {
  const mutation = useCapaMutation();
  const [form, setForm] = useState(() => Object.fromEntries(FIVE_W2H.map((q) => [q.key, capa.problem[q.key] ?? ""])));
  const submit = (e) => {
    e.preventDefault();
    const changes = {};
    for (const q of FIVE_W2H) if (form[q.key].trim() !== (capa.problem[q.key] ?? "")) changes[`d2${q.key[0].toUpperCase()}${q.key.slice(1)}`] = form[q.key].trim() || null;
    if (Object.keys(changes).length === 0) return onClose();
    mutation.mutate({ action: "update", id: capa.id, body: changes }, { onSuccess: onClose });
  };
  return (
    <Dialog title="5W2H: describe the problem" onClose={onClose} width="max-w-3xl">
      <form className="flex flex-col gap-3" noValidate onSubmit={submit}>
        <p className="text-sm text-secondary-text">Answer each question with facts. What, where and when are needed to complete D2.</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {FIVE_W2H.map((q) => (
            <TextAreaField key={q.key} label={q.label} required={q.required} value={form[q.key]} onChange={(e) => setForm((f) => ({ ...f, [q.key]: e.target.value }))} rows={3} maxLength={2000} hint={q.prompt} />
          ))}
        </div>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending} loading={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save 5W2H"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** The rows of an analysis, with the standard questions filled in for any that are missing. */
const rowsFor = (analysis) => IS_IS_NOT_ROWS.map((base) => ({ is: "", isNot: "", distinctive: "", changes: "", ...base, ...(analysis?.data?.rows ?? []).find((r) => r.key === base.key) }));

const IsIsNotDialog = ({ capa, analysis, onClose }) => {
  const mutation = useCapaMutation();
  const [title, setTitle] = useState(analysis?.title ?? "Is / Is-Not");
  const [rows, setRows] = useState(() => rowsFor(analysis));
  const set = (key, field) => (e) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: e.target.value } : r)));
  const submit = (e) => {
    e.preventDefault();
    const data = { rows: rows.map((r) => ({ key: r.key, dimension: r.dimension, question: r.question, is: r.is.trim(), isNot: r.isNot.trim(), distinctive: r.distinctive.trim(), changes: r.changes.trim() })) };
    mutation.mutate(analysis ? { action: "updateAnalysis", id: analysis.id, body: { title: title.trim(), data } } : { action: "addAnalysis", id: capa.id, body: { kind: "is_is_not", title: title.trim(), data } }, { onSuccess: onClose });
  };
  let lastDimension = null;
  return (
    <Dialog title="Is / Is-Not comparison" onClose={onClose} width="max-w-6xl">
      <form className="flex flex-col gap-3" noValidate onSubmit={submit}>
        <p className="text-sm text-secondary-text">Compare where the problem is with where it could be but is not. What is distinctive about the IS, and what changed, points to the cause.</p>
        <Field label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className="max-w-md" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] border-separate border-spacing-0 text-sm" aria-label="Is / Is-Not rows">
            <thead>
              <tr className="text-left text-secondary-text">
                <th scope="col" className="w-56 border-b border-border-color px-2 py-2 font-normal">Question</th>
                <th scope="col" className="border-b border-border-color px-2 py-2 font-normal">IS</th>
                <th scope="col" className="border-b border-border-color px-2 py-2 font-normal">IS NOT</th>
                <th scope="col" className="border-b border-border-color px-2 py-2 font-normal">What is distinctive?</th>
                <th scope="col" className="border-b border-border-color px-2 py-2 font-normal">What changed?</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const heading = r.dimension !== lastDimension;
                lastDimension = r.dimension;
                return [
                  heading && (
                    <tr key={`${r.dimension}-h`}>
                      <th colSpan={5} scope="colgroup" className="bg-secondary-bg px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-secondary-text">{DIMENSIONS[r.dimension]}</th>
                    </tr>
                  ),
                  <tr key={r.key}>
                    <th scope="row" className="border-b border-border-color px-2 py-2 text-left align-top font-normal text-primary-text">{r.question}</th>
                    {["is", "isNot", "distinctive", "changes"].map((f) => (
                      <td key={f} className="border-b border-border-color p-1 align-top">
                        <textarea aria-label={`${r.question} — ${f === "is" ? "IS" : f === "isNot" ? "IS NOT" : f === "distinctive" ? "distinctive" : "changed"}`} value={r[f]} onChange={set(r.key, f)} rows={2} maxLength={1000}
                          className="w-full min-w-36 rounded-lg border border-border-color bg-text-input-color p-2 text-sm text-primary-text focus:border-brand-primary focus:outline-none" />
                      </td>
                    ))}
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        </div>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending || !title.trim()} loading={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save comparison"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const answered = (analysis) => rowsFor(analysis).filter((r) => r.is.trim() || r.isNot.trim()).length;

/** D2: describe the problem precisely. The 5W2H and the Is / Is-Not comparison open as modals. */
const D2Problem = ({ capa, editable }) => {
  const mutation = useCapaMutation();
  const [dialog, setDialog] = useState(null); // "5w2h" | { analysis } | "new" | { remove }
  const isIsNots = capa.analyses.filter((a) => a.kind === "is_is_not");
  const close = () => setDialog(null);
  return (
    <div className="flex flex-col gap-4">
      {capa.problemStatement && (
        <p className="rounded-lg border border-border-color bg-primary-bg p-3 text-sm text-primary-text">
          <span className="text-secondary-text">Problem statement: </span>
          {capa.problemStatement}
        </p>
      )}
      <MenuCard title="5W2H" subtitle="What, where, when, who, why it matters, how and how many"
        action={editable ? <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setDialog("5w2h")}>Open 5W2H</CTAButton> : undefined}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2" aria-label="5W2H answers">
          {FIVE_W2H.map((q) => (
            <div key={q.key}>
              <dt className="text-secondary-text">{q.label}{q.required && <span className="text-error-color" title="Needed to complete D2"> *</span>}</dt>
              <dd className="whitespace-pre-wrap text-primary-text">{capa.problem[q.key] || <span className="text-secondary-text">Not described yet</span>}</dd>
            </div>
          ))}
        </dl>
      </MenuCard>
      <MenuCard title="Is / Is-Not" subtitle="Where the problem is, and where it could be but is not"
        action={editable ? <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setDialog("new")}>New Is / Is-Not comparison</CTAButton> : undefined}>
        {isIsNots.length === 0 ? (
          <p className="text-sm text-secondary-text">No comparison yet. It helps to narrow the cause when the problem happens on some parts, machines or shifts and not others.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-color" aria-label="Is / Is-Not comparisons">
            {isIsNots.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div className="flex flex-col">
                  <span className="font-medium text-primary-text">{a.title}</span>
                  <span className="text-xs text-secondary-text">{answered(a)} of {IS_IS_NOT_ROWS.length} questions answered{a.createdBy ? ` · by ${a.createdBy.name}` : ""}</span>
                </div>
                <div className="flex gap-2">
                  <CTAButton buttonType="button" type="neutral" size="md" aria-label={`${editable ? "Open" : "View"} ${a.title}`} onClick={() => setDialog({ analysis: a })}>{editable ? "Open" : "View"}</CTAButton>
                  {editable && <CTAButton buttonType="button" type="neutral" size="md" aria-label={`Remove ${a.title}`} onClick={() => { mutation.reset(); setDialog({ remove: a }); }}>Remove</CTAButton>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </MenuCard>
      {dialog === "5w2h" && <FiveW2HDialog capa={capa} onClose={close} />}
      {(dialog === "new" || dialog?.analysis) && <IsIsNotDialog capa={capa} analysis={dialog?.analysis} onClose={close} />}
      {dialog?.remove && (
        <ReasonDialog title={`Remove ${dialog.remove.title}?`} label="Why is it being removed?" confirmText="Remove" pending={mutation.isPending} error={mutation.error} onClose={close}
          onConfirm={() => mutation.mutate({ action: "removeAnalysis", id: dialog.remove.id }, { onSuccess: close })} />
      )}
    </div>
  );
};

export default D2Problem;
