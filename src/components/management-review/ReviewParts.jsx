import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CircleCheckIcon, RefreshCwIcon } from "@/components/icons";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import { TextAreaField } from "../master-data/shared";
import { useReviewInput } from "../../hooks/useManagementReview";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { figureWords } from "../../lib/qualityObjectives";

const when = (iso) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** A gathered section: its figures (each in words) and lists, exactly as frozen. */
export const SnapshotView = ({ snapshot }) => {
  if (!snapshot) return null;
  return (
    <div className="flex flex-col gap-3">
      {snapshot.figures?.length > 0 && (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          {snapshot.figures.map((f) => (
            <div key={f.label} className="flex flex-col rounded-xl border border-border-color bg-primary-bg px-3 py-2">
              <dt className="text-xs text-secondary-text">{f.label}</dt>
              <dd className="text-lg font-semibold tabular-nums text-primary-text">{figureWords(f)}</dd>
              {f.note && <dd className="text-xs text-secondary-text">{f.note}</dd>}
            </div>
          ))}
        </dl>
      )}
      {snapshot.lists
        ?.filter((l) => l.items.length > 0)
        .map((l) => (
          <div key={l.title} className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-primary-text">{l.title}</span>
            <ul aria-label={l.title} className="flex flex-col divide-y divide-border-color text-sm">
              {l.items.map((it, i) => (
                <li key={`${it.label}-${i}`} className="flex flex-wrap items-baseline justify-between gap-2 py-1">
                  <span className="min-w-0">
                    {it.link ? (
                      <Link to={it.link} className="text-primary-text hover:underline">
                        {it.label}
                      </Link>
                    ) : (
                      <span className="text-primary-text">{it.label}</span>
                    )}
                    {it.note && <span className="block text-xs text-secondary-text">{it.note}</span>}
                  </span>
                  {it.value !== undefined && it.value !== null && <span className="tabular-nums text-secondary-text">{figureWords({ value: it.value })}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      {snapshot.notes?.map((n) => (
        <p key={n} className="text-xs text-secondary-text">
          {n}.
        </p>
      ))}
    </div>
  );
};

/**
 * One input section: the gathered figures (or "not available to you"), commentary saved when the box is left, and "Reviewed" (optimistic).
 * Read-only once the review is not being held.
 */
export const InputCard = ({ review, input, onGather, gathering }) => {
  const save = useReviewInput(review.id);
  const { showToast } = useToast();
  const [text, setText] = useState(input.commentary ?? "");
  useEffect(() => setText(input.commentary ?? ""), [input.commentary]);
  // The tick shows at once (the cache updates a moment later) and is put back if the save is refused.
  const [ticked, setTicked] = useState(input.reviewed);
  useEffect(() => setTicked(input.reviewed), [input.reviewed]);
  const holding = review.canHold;
  const send = (reviewed, commentary = text) => {
    setTicked(reviewed);
    save.mutate(
      { inputId: input.id, commentary: commentary.trim() || null, reviewed },
      {
        onError: (err) => {
          setTicked(input.reviewed);
          showToast({ type: "error", title: "Not saved", message: describeApiError(err) });
        },
      },
    );
  };
  const canTick = input.commentaryOnly ? !!text.trim() : !!input.gatheredAt;

  return (
    <section aria-label={input.title} className={`flex flex-col gap-3 rounded-2xl border bg-secondary-bg p-4 ${ticked ? "border-success-color/50" : "border-border-color"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col">
          <h3 className="flex items-center gap-2 text-base font-semibold text-primary-text">
            {ticked && <CircleCheckIcon className="text-success-color" aria-hidden="true" />}
            {input.title}
          </h3>
          <span className="text-xs text-secondary-text">
            {input.commentaryOnly
              ? "Commentary only"
              : input.gatheredAt
                ? `Gathered ${when(input.gatheredAt)}${input.gatheredBy ? ` by ${input.gatheredBy}` : ""}`
                : review.status === "planned"
                  ? "Gathered when the review starts"
                  : "Not gathered"}
            {input.reviewed && input.reviewedBy ? ` · reviewed by ${input.reviewedBy}` : ""}
          </span>
        </div>
        {holding && !input.commentaryOnly && (
          <CTAButton type="neutral" onClick={() => onGather(input.section)} loading={gathering} aria-label={`Gather ${input.title} again`}>
            <RefreshCwIcon aria-hidden="true" /> Gather again
          </CTAButton>
        )}
      </div>
      {input.available === false && <Callout tone="info">Not available to you: you may not read what this section is gathered from. Someone who can should gather it.</Callout>}
      <SnapshotView snapshot={input.snapshot} />
      {holding ? (
        <>
          <TextAreaField label="Commentary" required={input.commentaryOnly} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== (input.commentary ?? "") && send(ticked)} maxLength={8000} rows={2} />
          <label className="flex items-center gap-2 text-sm text-primary-text">
            <input type="checkbox" checked={ticked} disabled={!canTick && !ticked} onChange={(e) => send(e.target.checked)} className="h-4 w-4" />
            Reviewed in the meeting
            {!canTick && !ticked && <span className="text-xs text-secondary-text">({input.commentaryOnly ? "write the commentary first" : "gather the figures first"})</span>}
          </label>
        </>
      ) : (
        input.commentary && <p className="whitespace-pre-line text-sm text-primary-text">{input.commentary}</p>
      )}
    </section>
  );
};
