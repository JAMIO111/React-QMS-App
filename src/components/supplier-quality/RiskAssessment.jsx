import { useEffect, useMemo, useState } from "react";
import { TriangleAlertIcon } from "@/components/icons";
import { usePreviewRisk, useRiskAssessments, useRiskMutation, useRiskModel } from "../../hooks/useSupplierQuality";
import { formatDate } from "../../lib/ncr";
import { formatDateTime } from "../../lib/processControl";
import { RISK_LEVELS } from "../../lib/supplierRisk";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice, FormError, TextAreaField } from "../master-data/shared";
import { RiskBadge } from "./SupplierBadges";
import { todayIso } from "@/lib/localDate";

const levelName = (n) => RISK_LEVELS.find((l) => l.value === n)?.label ?? String(n);

/** The factors of an assessment: what was scored, how much it counts, and the note. */
const FactorTable = ({ factors }) => (
  <table className="w-full text-left text-sm" aria-label="Factor scores">
    <thead>
      <tr className="text-secondary-text">
        <th className="py-1 pr-3 font-medium">Factor</th>
        <th className="py-1 pr-3 font-medium">Weight</th>
        <th className="py-1 pr-3 font-medium">Score</th>
        <th className="py-1 font-medium">Note</th>
      </tr>
    </thead>
    <tbody>
      {factors.map((f) => (
        <tr key={f.key} className="border-t border-border-color align-top">
          <td className="py-1.5 pr-3 text-primary-text">
            {f.label}
            {f.escalates && f.score === 4 && <span className="ml-1.5 inline-flex items-center gap-0.5 text-xs text-error-color"><TriangleAlertIcon className="h-3 w-3" /> raises the rating</span>}
          </td>
          <td className="py-1.5 pr-3 tabular-nums text-secondary-text">{f.weight}</td>
          <td className="py-1.5 pr-3 text-primary-text">{levelName(f.score)}</td>
          <td className="py-1.5 text-secondary-text">{f.note ?? "—"}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

/** The working-out, in words: the index, the band, and what lifted the rating. */
const Workings = ({ result }) => (
  <p className="text-sm text-secondary-text">
    Weighted score {result.index.toFixed(2)} of 4 → <strong className="text-primary-text">{result.band}</strong> band
    {result.rating !== result.band ? (
      <>
        , raised to <strong className="text-primary-text">{result.rating}</strong> because {result.escalatedBy.join(" and ")} {result.escalatedBy.length === 1 ? "is" : "are"} critical
      </>
    ) : null}
    . Model version {result.modelVersion}.
  </p>
);

/** Score every factor 1 to 4 with a note, say why, and see the rating the database works out before saving it. */
const AssessDialog = ({ supplier, model, onClose }) => {
  const mutation = useRiskMutation();
  const preview = usePreviewRisk();
  const [scores, setScores] = useState({});
  const [notes, setNotes] = useState({});
  const [rationale, setRationale] = useState("");
  const [reviewOn, setReviewOn] = useState("");
  const all = model.factors.every((f) => scores[f.key]);
  const body = useMemo(() => model.factors.map((f) => ({ key: f.key, score: scores[f.key], note: notes[f.key]?.trim() || null })), [model, scores, notes]);
  const tomorrow = todayIso(1);

  useEffect(() => {
    if (!all) return undefined;
    const t = setTimeout(() => preview.mutate({ id: supplier.id, scores: body }), 250);
    return () => clearTimeout(t);
    // the preview mutation object changes every render; the inputs that matter are listed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, body, supplier.id]);

  const submit = (e) => {
    e.preventDefault();
    if (!all || rationale.trim().length < 3) return;
    mutation.mutate({ action: "record", id: supplier.id, body: { scores: body, rationale: rationale.trim(), ...(reviewOn ? { reviewOn } : {}) } }, { onSuccess: onClose });
  };

  return (
    <Dialog title={`Assess the risk of ${supplier.displayName || supplier.name}`} onClose={onClose} width="max-w-3xl">
      <form noValidate className="flex flex-col gap-4" onSubmit={submit}>
        <p className="text-sm text-secondary-text">Score each factor from low to critical. Heavier factors count for more; some raise the rating by themselves when critical. The rating is worked out for you.</p>
        <ul className="flex flex-col gap-3" aria-label="Factors">
          {model.factors.map((f) => (
            <li key={f.key} className="flex flex-col gap-1.5 rounded-lg border border-border-color p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-primary-text" data-required>{f.label}</span>
                <span className="text-xs text-secondary-text">Weight {f.weight}{f.escalates ? " · critical raises the rating" : ""}</span>
              </div>
              {f.description && <p className="text-xs text-secondary-text">{f.description}</p>}
              <SlidingToggle ariaLabel={`${f.label} score`} mode="radio" options={RISK_LEVELS.map((l) => ({ value: String(l.value), label: l.label }))} value={scores[f.key] ? String(scores[f.key]) : undefined} onChange={(v) => setScores((s) => ({ ...s, [f.key]: Number(v) }))} />
              <input
                aria-label={`Note on ${f.label}`}
                placeholder="Note (optional)"
                value={notes[f.key] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [f.key]: e.target.value }))}
                maxLength={1000}
                className="rounded-lg border border-border-color bg-text-input-color px-3 py-1.5 text-sm text-primary-text focus:outline-none focus:border-brand-primary"
              />
            </li>
          ))}
        </ul>
        <div aria-live="polite">
          {!all ? (
            <p className="text-sm text-secondary-text">Score every factor to see the rating.</p>
          ) : preview.data ? (
            <Callout tone={preview.data.rating === "low" ? "success" : preview.data.rating === "medium" ? "info" : "warning"} title={`Rating: ${preview.data.rating}`}>
              <Workings result={preview.data} />
            </Callout>
          ) : preview.error ? (
            <ErrorNotice error={preview.error} />
          ) : (
            <p className="text-sm text-secondary-text">Working it out…</p>
          )}
        </div>
        <TextAreaField label="Rationale" required value={rationale} onChange={(e) => setRationale(e.target.value)} maxLength={2000} rows={3} hint="Why this rating: what you looked at and what it shows" />
        <RHFDatePickerPopout label="Next review" valueFormat="iso" clearable minDate={tomorrow} value={reviewOn} onChange={(v) => setReviewOn(v ?? "")} placeholder={`In ${model.reviewIntervalMonths} months (the model's interval)`} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!all || rationale.trim().length < 3 || mutation.isPending} loading={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Record assessment"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** A supplier's risk: the current rating with its working-out, the review date, and every earlier assessment. */
export const RiskCard = ({ supplier, canManage }) => {
  const query = useRiskAssessments(supplier.id);
  const model = useRiskModel();
  const [open, setOpen] = useState(false);
  const list = query.data?.data ?? [];
  const current = list.find((a) => a.status === "current");
  const past = list.filter((a) => a.status !== "current");

  return (
    <MenuCard
      title="Risk assessment"
      subtitle="How much risk this supplier brings, scored on the organisation's risk model. Only an assessment sets the risk rating."
      action={canManage && model.data && (
        <CTAButton buttonType="button" type="secondary" size="default" onClick={() => setOpen(true)}>{current ? "Assess again" : "Assess risk"}</CTAButton>
      )}>
      {query.error && <ErrorNotice error={query.error} />}
      {query.isLoading ? (
        <p className="text-sm text-secondary-text">Loading…</p>
      ) : !current ? (
        <p className="text-sm text-secondary-text">Not assessed yet. The supplier has no risk rating.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {current.reviewOverdue && (
            <Callout tone="warning" role="status" title="This assessment is due for review">
              The review was due on {formatDate(current.reviewOn)}. The rating still stands until it is assessed again.
            </Callout>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <RiskBadge risk={current.rating} />
            <span className="text-sm text-secondary-text">
              Assessed {formatDateTime(current.assessedAt)}{current.assessedBy ? ` by ${current.assessedBy.name}` : ""} · next review {formatDate(current.reviewOn)}
              {current.previousRating ? ` · was ${current.previousRating}` : ""}
            </span>
          </div>
          <Workings result={current} />
          <div>
            <h3 className="text-sm font-medium text-secondary-text">Rationale</h3>
            <p className="whitespace-pre-wrap text-sm text-primary-text">{current.rationale}</p>
          </div>
          <FactorTable factors={current.factors} />
        </div>
      )}
      {past.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-secondary-text">Earlier assessments ({past.length})</summary>
          <ul className="mt-2 flex flex-col gap-2 text-sm" aria-label="Earlier assessments">
            {past.map((a) => (
              <li key={a.id} className="rounded-lg border border-border-color p-2">
                <p className="flex flex-wrap items-center gap-2 text-primary-text">
                  <RiskBadge risk={a.rating} /> {formatDateTime(a.assessedAt)}{a.assessedBy ? ` · ${a.assessedBy.name}` : ""} · model version {a.modelVersion} · score {a.index.toFixed(2)}
                </p>
                <p className="mt-1 text-secondary-text">{a.rationale}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
      {open && model.data && <AssessDialog supplier={supplier} model={model.data} onClose={() => setOpen(false)} />}
    </MenuCard>
  );
};
