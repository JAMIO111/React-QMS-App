import { CircleAlertIcon, CircleCheckIcon } from "@/components/icons";
import { STATUS } from "../../lib/inspection";

export const StatusPill = ({ status }) => {
  const s = STATUS[status] ?? STATUS.in_progress;
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${s.className}`}>{s.label}</span>;
};

/** Pass / fail with an icon and a word, never colour alone. */
export const ResultBadge = ({ result, size = "sm" }) => {
  if (!result) return <span className="text-secondary-text">—</span>;
  const pass = result === "pass";
  const Icon = pass ? CircleCheckIcon : CircleAlertIcon;
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 font-medium ${size === "lg" ? "text-sm" : "text-xs"} ${
        pass ? "bg-success-color/15 text-success-color" : "bg-error-color/15 text-error-color"
      }`}>
      <Icon className="h-3.5 w-3.5" /> {pass ? "Pass" : "Fail"}
    </span>
  );
};
