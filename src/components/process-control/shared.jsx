import { REVISION_STATUS } from "../../hooks/useProcessControl";

export const RevisionStatusPill = ({ status }) => {
  const s = REVISION_STATUS[status] ?? { label: status, className: "bg-border-color text-secondary-text" };
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${s.className}`}>{s.label}</span>;
};
