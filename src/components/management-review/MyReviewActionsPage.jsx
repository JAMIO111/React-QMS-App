import { useState } from "react";
import { Link } from "react-router-dom";
import { ListChecksIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import SlidingToggle from "../ui/SlidingToggle";
import { Card } from "../dashboard/DashboardParts";
import { Chip, Empty } from "../dashboard/DashboardGraphics";
import { useMyReviewActions } from "../../hooks/useManagementReview";
import { usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { formatDay, reviewPath } from "../../lib/qualityObjectives";
import { TextDialog } from "./ReviewDialogs";

const STATUS = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
  { value: "all", label: "All" },
];

/**
 * My review actions (`/Management-Review/My-Actions`): management review actions given to me, with the review they came from, and Mark done. Open to every member:
 * the person an action is given to may hold no management review permission (then the review is named but not linked). Notices about these actions lead here.
 */
const MyReviewActionsPage = () => {
  const [status, setStatus] = useState("open");
  const [done, setDone] = useState(null);
  const { can } = usePermissions();
  const { data, isLoading, error } = useMyReviewActions(status);
  const canRead = can("management_review.read");

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <ListChecksIcon className="h-6 w-6" aria-hidden="true" />
            My review actions
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            {data ? `${data.openCount} open${data.overdueCount ? ` · ${data.overdueCount} overdue` : ""}` : "Actions from management reviews given to you"}
          </p>
        </div>
        <SlidingToggle ariaLabel="Which actions" options={STATUS} value={status} onChange={setStatus} />
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}

      <Card title="Actions">
        {data?.data.length ? (
          <ul aria-label="My review actions" className="flex flex-col divide-y divide-border-color text-sm">
            {data.data.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium text-primary-text">{a.description}</span>
                  <span className="text-xs text-secondary-text">
                    {canRead ? (
                      <Link to={reviewPath(a.review.id)} className="hover:underline">
                        {a.review.reference} · {a.review.title}
                      </Link>
                    ) : (
                      `${a.review.reference} · ${a.review.title}`
                    )}
                    {a.dueDate ? ` · due ${formatDay(a.dueDate)}` : ""}
                  </span>
                  {a.doneNote && <span className="text-xs text-secondary-text">Done: {a.doneNote}</span>}
                </span>
                <span className="flex items-center gap-2">
                  {a.overdue && <Chip tone="error">overdue</Chip>}
                  {a.status === "cancelled" && <Chip>cancelled</Chip>}
                  {a.status === "open" && a.review.status !== "cancelled" && (
                    <CTAButton type="secondary" onClick={() => setDone(a)} aria-label={`Mark done: ${a.description}`}>
                      Mark done
                    </CTAButton>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{isLoading ? "Loading…" : status === "open" ? "No management review action is waiting for you." : "Nothing here."}</Empty>
        )}
      </Card>

      {done && (
        <TextDialog title="Mark the action done" intro={done.description} label="What was done" field="note" min={1} max={2000} confirm="Mark done" command={{ action: "completeAction", id: done.id }} onClose={() => setDone(null)} />
      )}
    </div>
  );
};

export default MyReviewActionsPage;
