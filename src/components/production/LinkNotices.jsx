import { TriangleAlertIcon } from "@/components/icons";
import { linkNotices } from "../../lib/production";

/** What is worth knowing about the production records a job or non-conformance is linked to (a lot on hold, a closed order). Information only. */
const LinkNotices = ({ links }) => {
  const notices = linkNotices(links);
  if (!notices.length) return null;
  return (
    <ul aria-label="About the linked production records" className="flex flex-col gap-1">
      {notices.map((n) => (
        <li key={n.key} className="flex items-start gap-2 rounded-lg border border-warning-color/40 bg-warning-color/10 px-3 py-2 text-sm text-primary-text">
          <TriangleAlertIcon className="mt-0.5 shrink-0 text-warning-color" />
          {n.text}
        </li>
      ))}
    </ul>
  );
};

export default LinkNotices;
