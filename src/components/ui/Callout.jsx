import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "@/components/icons";

/**
 * A notice card with an icon: `tone` "success" (green, tick), "info" (blue, info), "warning" (amber, triangle) or "error" (red, alert). Use it instead
 * of a plain bordered paragraph for anything the person should notice: confirmations, explanations, cautions, problems. `title` is an optional bold first
 * line; children are the text; `action` is an optional element (a button) at the right. Colour never carries the meaning alone: the icon and words do too.
 * `role` is left off unless given: "status" for a notice that changes while the page is open, "alert" for a problem that needs attention at once.
 */
const TONES = {
  success: { Icon: CircleCheckIcon, box: "border-success-color/50 bg-success-color/10", icon: "text-success-color" },
  info: { Icon: InfoIcon, box: "border-info-color/50 bg-info-color/10", icon: "text-info-color" },
  warning: { Icon: TriangleAlertIcon, box: "border-warning-color/60 bg-warning-color/10", icon: "text-warning-color" },
  error: { Icon: CircleAlertIcon, box: "border-error-color/50 bg-error-color/10", icon: "text-error-color" },
};

const Callout = ({ tone = "info", title, children, action, role, className = "", ...rest }) => {
  const t = TONES[tone] ?? TONES.info;
  return (
    <div role={role} className={`flex items-start gap-3 rounded-lg border p-3 text-sm text-primary-text ${t.box} ${className}`} {...rest}>
      <t.Icon className={`mt-0.5 h-5 w-5 shrink-0 ${t.icon}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        <div className={title ? "mt-0.5" : ""}>{children}</div>
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
};

export default Callout;
