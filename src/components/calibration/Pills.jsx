import { DUE_STATES, describeDue, outcomeOf, statusOf } from "../../lib/calibration";

const pill = "inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium";

export const GaugeStatusPill = ({ status }) => {
  const s = statusOf(status);
  return <span className={`${pill} ${s.tone}`}>{s.label}</span>;
};

export const OutcomePill = ({ outcome }) => {
  const o = outcomeOf(outcome);
  if (!o) return <span className="text-secondary-text">—</span>;
  return (
    <span className={`${pill} ${o.tone}`} title={o.help}>
      {o.label}
    </span>
  );
};

/** Due state with the days to go (or overdue) as a tooltip. */
export const DuePill = ({ state, days }) => {
  const d = DUE_STATES[state] ?? DUE_STATES.not_set;
  return (
    <span className={`${pill} ${d.tone}`} title={describeDue(days) || undefined}>
      {d.label}
    </span>
  );
};
