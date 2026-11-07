import { useState } from "react";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFComboBox from "../ui/RHFComboBox";
import { useCapaMutation } from "../../hooks/useCapa";
import { ROOT_CAUSE_KINDS, ROOT_CAUSE_OPTIONS } from "../../lib/capa";
import { FormError, TextAreaField, buttonClass } from "../master-data/shared";

const MIN_ROWS = 3;
const MAX_ROWS = 8;

/**
 * 5 Whys as a modal: the problem, then a chain of "why?" answers, each asked about the one before, ending in the root cause. A chain explains
 * one kind of cause (why it occurred, why it escaped, or the systemic cause). "Save and record as root cause" saves the chain and adds its
 * conclusion to the root causes of D4, to be verified.
 */
const FiveWhysDialog = ({ capa, analysis, onClose }) => {
  const mutation = useCapaMutation();
  const saved = analysis?.data ?? {};
  const [title, setTitle] = useState(analysis?.title ?? "5 Whys");
  const [kind, setKind] = useState(saved.kind ?? "occurrence");
  const [problem, setProblem] = useState(
    saved.problem ?? capa.problem.what ?? capa.title,
  );
  const [whys, setWhys] = useState(() => {
    const answers = (saved.whys ?? []).map((w) => w.because);
    while (answers.length < MIN_ROWS) answers.push("");
    return answers;
  });
  const [rootCause, setRootCause] = useState(saved.rootCause ?? "");
  const alreadyRecorded =
    !!analysis &&
    capa.rootCauses.some(
      (r) =>
        r.sourceAnalysisId === analysis.id &&
        r.description === rootCause.trim(),
    );

  const data = () => ({
    kind,
    problem: problem.trim(),
    whys: whys.map((w) => ({ because: w.trim() })).filter((w) => w.because),
    rootCause: rootCause.trim(),
  });
  const save = async () => {
    if (analysis) {
      await mutation.mutateAsync({
        action: "updateAnalysis",
        id: analysis.id,
        body: { title: title.trim(), data: data() },
      });
      return analysis.id;
    }
    const before = new Set(capa.analyses.map((a) => a.id));
    const res = await mutation.mutateAsync({
      action: "addAnalysis",
      id: capa.id,
      body: { kind: "five_whys", title: title.trim(), data: data() },
    });
    return res.analyses.find((a) => !before.has(a.id)).id;
  };
  const run = (record) => async (e) => {
    e?.preventDefault();
    try {
      const id = await save();
      if (record)
        await mutation.mutateAsync({
          action: "addRootCause",
          id: capa.id,
          body: { kind, description: rootCause.trim(), sourceAnalysisId: id },
        });
      onClose();
    } catch {
      /* the error is shown below */
    }
  };

  return (
    <Dialog title="5 Whys" onClose={onClose} width="max-w-3xl">
      <form className="flex flex-col gap-4" noValidate onSubmit={run(false)}>
        <p className="text-sm text-secondary-text">
          Ask why, answer from facts, then ask why of that answer. Stop when you
          reach something you can fix and verify.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Title"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
          <RHFComboBox
            label="This chain explains"
            value={kind}
            onChange={(v) => setKind(v ?? "occurrence")}
            options={ROOT_CAUSE_OPTIONS}
            sort={false}
            clearable={false}
            hint={ROOT_CAUSE_KINDS[kind].help}
          />
        </div>
        <TextAreaField
          label="The problem"
          value={problem}
          onChange={(e) => setProblem(e.target.value)}
          rows={2}
          maxLength={500}
          className="text-sm"
        />
        <ol className="flex flex-col gap-3" aria-label="Whys">
          {whys.map((w, i) => (
            <li key={i} className="flex flex-col gap-1">
              <span className="text-sm font-medium text-secondary-text">
                Why {i + 1}: why did{" "}
                {i === 0
                  ? problem.trim()
                    ? `“${problem.trim().slice(0, 80)}”`
                    : "the problem"
                  : `“${(whys[i - 1] || "that").trim().slice(0, 80)}”`}{" "}
                happen?
              </span>
              <textarea
                aria-label={`Because (why ${i + 1})`}
                value={w}
                rows={2}
                maxLength={500}
                onChange={(e) =>
                  setWhys((ws) =>
                    ws.map((x, j) => (j === i ? e.target.value : x)),
                  )
                }
                className="w-full rounded-lg text-sm border border-border-color bg-text-input-color p-2 text-primary-text focus:border-brand-primary focus:outline-none"
                placeholder="Because…"
              />
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass.neutral}
            disabled={whys.length >= MAX_ROWS}
            onClick={() => setWhys((ws) => [...ws, ""])}>
            Add another why
          </button>
          <button
            type="button"
            className={buttonClass.neutral}
            disabled={whys.length <= MIN_ROWS}
            onClick={() => setWhys((ws) => ws.slice(0, -1))}>
            Remove the last why
          </button>
        </div>
        <TextAreaField
          label="The root cause"
          value={rootCause}
          onChange={(e) => setRootCause(e.target.value)}
          rows={2}
          maxLength={500}
          hint="The conclusion of the chain, in one sentence"
        />
        <FormError error={mutation.error} />
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className={buttonClass.neutral}
            onClick={onClose}>
            Close
          </button>
          <button
            type="submit"
            className={buttonClass.neutral}
            disabled={mutation.isPending || !title.trim()}>
            Save analysis
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={
              mutation.isPending ||
              !title.trim() ||
              !rootCause.trim() ||
              alreadyRecorded
            }
            onClick={run(true)}>
            {alreadyRecorded
              ? "Already a root cause"
              : "Save and record as root cause"}
          </button>
        </div>
      </form>
    </Dialog>
  );
};

export default FiveWhysDialog;
