import { useState } from "react";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import { useCapaMutation } from "../../hooks/useCapa";
import { ISHIKAWA_CATEGORIES } from "../../lib/capa";
import { FormError } from "../master-data/shared";
import IshikawaDiagram from "./IshikawaDiagram";
import CTAButton from "@/components/CTAButton";

const initial = (analysis) => Object.fromEntries(ISHIKAWA_CATEGORIES.map((c) => [c.key, analysis?.data?.categories?.find((x) => x.key === c.key)?.causes ?? []]));
let counter = 0;
const newId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`;

const Category = ({ cat, causes, canRecord, recorded, busy, onChange, onRecord }) => {
  const [draft, setDraft] = useState("");
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    onChange([...causes, { id: newId(), text: text.slice(0, 300), probable: false }]);
    setDraft("");
  };
  return (
    <section aria-label={cat.label} className="flex flex-col gap-2 rounded-xl border border-border-color p-3">
      <h3 className="text-sm font-semibold text-primary-text">{cat.label} <span className="font-normal text-secondary-text">· {cat.hint}</span></h3>
      <ul className="flex flex-col gap-1">
        {causes.map((c) => (
          <li key={c.id} className="flex items-start gap-2 text-sm">
            <button type="button" aria-pressed={c.probable} aria-label={`Mark "${c.text}" as probable`} title="Probable cause: investigate first"
              className={`mt-0.5 h-5 w-5 shrink-0 rounded border text-xs ${c.probable ? "border-brand-primary bg-brand-primary text-white" : "border-border-color text-secondary-text"} cursor-pointer`}
              onClick={() => onChange(causes.map((x) => (x.id === c.id ? { ...x, probable: !x.probable } : x)))}>★</button>
            <span className={`min-w-0 flex-1 break-words ${c.probable ? "font-medium text-primary-text" : "text-primary-text"}`}>{c.text}</span>
            {canRecord && (
              <button type="button" className="shrink-0 text-xs text-link-color hover:underline disabled:opacity-50 disabled:no-underline cursor-pointer" disabled={busy || recorded.has(c.text)}
                aria-label={`Record "${c.text}" as a root cause`} onClick={() => onRecord(c)}>{recorded.has(c.text) ? "Recorded" : "Record as root cause"}</button>
            )}
            <button type="button" aria-label={`Remove "${c.text}"`} className="shrink-0 text-secondary-text hover:text-error-color cursor-pointer" onClick={() => onChange(causes.filter((x) => x.id !== c.id))}>×</button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input aria-label={`Add a cause under ${cat.label}`} value={draft} maxLength={300} placeholder="A possible cause…" onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
          className="min-w-0 flex-1 rounded-lg border border-border-color bg-text-input-color px-2 min-h-9.5 py-1.5 text-sm text-primary-text focus:border-brand-primary focus:outline-none" />
        <CTAButton buttonType="button" type="neutral" size="md" onClick={add} disabled={!draft.trim()} aria-label={`Add to ${cat.label}`}>Add</CTAButton>
      </div>
    </section>
  );
};

/**
 * Ishikawa (cause and effect) diagram as a modal: the effect, and possible causes under Man, Machine, Material, Method, Measurement and Environment.
 * Star the probable ones. Once the diagram is saved, any cause can be recorded as a root cause (to be verified).
 */
const IshikawaDialog = ({ capa, analysis, onClose }) => {
  const mutation = useCapaMutation();
  const [title, setTitle] = useState(analysis?.title ?? "Ishikawa diagram");
  const [effect, setEffect] = useState(analysis?.data?.effect ?? capa.problem.what ?? capa.title);
  const [causes, setCauses] = useState(() => initial(analysis));
  const recorded = new Set(capa.rootCauses.filter((r) => analysis && r.sourceAnalysisId === analysis.id).map((r) => r.description));
  const data = { effect: effect.trim(), categories: ISHIKAWA_CATEGORIES.map((c) => ({ key: c.key, causes: causes[c.key] })) };
  const save = () => mutation.mutate(analysis ? { action: "updateAnalysis", id: analysis.id, body: { title: title.trim(), data } } : { action: "addAnalysis", id: capa.id, body: { kind: "ishikawa", title: title.trim(), data } }, { onSuccess: onClose });
  const record = (cause) => mutation.mutate({ action: "addRootCause", id: capa.id, body: { kind: "occurrence", description: cause.text, sourceAnalysisId: analysis.id } });

  return (
    <Dialog title="Ishikawa diagram" onClose={onClose} width="max-w-6xl">
      <form className="flex flex-col gap-4" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
        <p className="text-sm text-secondary-text">List everything that could cause the effect, under each heading. Star the likely ones. Nothing here is a root cause until it is verified.</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          <Field label="Effect (the problem)" value={effect} onChange={(e) => setEffect(e.target.value)} maxLength={300} />
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {ISHIKAWA_CATEGORIES.map((cat) => (
            <Category key={cat.key} cat={cat} causes={causes[cat.key]} canRecord={!!analysis} recorded={recorded} busy={mutation.isPending}
              onChange={(next) => setCauses((c) => ({ ...c, [cat.key]: next }))} onRecord={record} />
          ))}
        </div>
        {!analysis && <p className="text-xs text-secondary-text">Save the diagram first; then each cause can be recorded as a root cause.</p>}
        <div className="rounded-xl border border-border-color bg-primary-bg p-2">
          <IshikawaDiagram effect={effect} categories={data.categories} />
        </div>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Close</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending || !title.trim()} loading={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save diagram"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

export default IshikawaDialog;
