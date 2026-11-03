import { severityOf, stageOf } from "../../lib/ncr";

export const StagePill = ({ stage }) => {
  const s = stageOf(stage);
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};

export const SeverityPill = ({ severity }) => {
  const s = severityOf(severity);
  if (!s) return <span className="text-secondary-text">—</span>;
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};
