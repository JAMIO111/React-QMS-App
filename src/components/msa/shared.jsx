import { TONE_CLASS, progressPct, progressWords, statusOf, validityWords, VALIDITY_TONE, verdictOf, bandTone, bandWords } from "../../lib/msa";

const Pill = ({ tone = "neutral", children, title }) => (
  <span title={title} className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}>
    {children}
  </span>
);

/** The state as a word, never colour alone. */
export const StatusPill = ({ status }) => {
  const s = statusOf(status);
  return <Pill tone={s.tone}>{s.label}</Pill>;
};

export const VerdictPill = ({ verdict }) => {
  const v = verdictOf(verdict);
  return <Pill tone={v.tone}>{v.label}</Pill>;
};

/** A band from an analysis (acceptable / marginal / unacceptable), in words. */
export const BandPill = ({ band }) => <Pill tone={bandTone(band)}>{bandWords(band)}</Pill>;

export const ValidityPill = ({ validity, validUntil }) => (validity ? <Pill tone={VALIDITY_TONE[validity.state]}>{validityWords(validity, validUntil)}</Pill> : null);

/** A bar and the same thing in words. */
export const Progress = ({ progress }) => {
  if (!progress || progress.total === 0) return <span className="text-xs text-secondary-text">—</span>;
  const pct = progressPct(progress);
  return (
    <div className="flex min-w-32 items-center gap-2" title={progressWords(progress)}>
      <div className="h-2 w-20 shrink-0 overflow-hidden rounded-full bg-border-color" aria-hidden="true">
        <div className="h-full rounded-full bg-brand-primary" style={{ width: `${pct}%` }} />
      </div>
      <span className="whitespace-nowrap text-xs text-secondary-text">
        {progress.filled}/{progress.total}
      </span>
    </div>
  );
};

export { Pill };
