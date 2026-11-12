import { Link } from "react-router-dom";
import { PresentationIcon } from "@/components/icons";
import { Card } from "../dashboard/DashboardParts";
import { Chip } from "../dashboard/DashboardGraphics";
import { useManagementReviewOverview } from "../../hooks/useManagementReview";
import { usePermissions } from "../../hooks/useQmsApi";
import { formatDay, REVIEW_STATUS, reviewPath } from "../../lib/qualityObjectives";

/** More than a year since the last completed review: worth saying (ISO 9001 asks for reviews "at planned intervals"; a year is the usual one). */
const STALE_DAYS = 365;

/**
 * Management review on the home page (MR3), for people who may read management reviews: the next review to hold, the last one completed (and how long ago),
 * open and overdue review actions, and how the quality objectives stand. Every figure is in words and links to its page.
 */
const ManagementReviewCard = () => {
  const { can, isLoading: loadingPermissions } = usePermissions();
  const allowed = !loadingPermissions && can("management_review.read");
  const { data } = useManagementReviewOverview({ enabled: allowed });
  if (!allowed || !data) return null;
  const { next, lastCompleted: last, actions, objectives } = data;
  const stale = !last || (last.daysAgo !== null && last.daysAgo > STALE_DAYS);

  return (
    <Card
      title="Management review"
      subtitle="The next review, the last one held, its actions and the quality objectives"
      action={
        <Link to="/Management-Review/Reviews" className="text-sm font-medium text-primary-text hover:underline">
          All reviews
        </Link>
      }>
      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
        <div className="flex flex-col gap-1 rounded-xl border border-border-color bg-primary-bg p-3">
          <span className="flex items-center gap-1 text-xs text-secondary-text">
            <PresentationIcon aria-hidden="true" /> Next review
          </span>
          {next ? (
            <>
              <Link to={reviewPath(next.id)} className="font-medium text-primary-text hover:underline">
                {next.reference} · {next.title}
              </Link>
              <span className="text-xs text-secondary-text">
                {REVIEW_STATUS[next.status]?.label}
                {next.status === "planned" && next.plannedOn ? ` · ${formatDay(next.plannedOn)}` : ""}
              </span>
            </>
          ) : (
            <span className="text-secondary-text">None planned</span>
          )}
        </div>
        <div className="flex flex-col gap-1 rounded-xl border border-border-color bg-primary-bg p-3">
          <span className="text-xs text-secondary-text">Last completed</span>
          {last ? (
            <>
              <Link to={reviewPath(last.id)} className="font-medium text-primary-text hover:underline">
                {last.reference} · {last.title}
              </Link>
              <span className="text-xs text-secondary-text">Held {formatDay(last.heldOn)}</span>
            </>
          ) : (
            <span className="text-secondary-text">None yet</span>
          )}
          {stale && <Chip tone="warning">{last ? "Over a year ago" : "No review completed"}</Chip>}
        </div>
        <div className="flex flex-col gap-1 rounded-xl border border-border-color bg-primary-bg p-3">
          <span className="text-xs text-secondary-text">Review actions open</span>
          <span className="text-2xl font-semibold tabular-nums text-primary-text">{actions.open}</span>
          {actions.overdue > 0 ? <Chip tone="error">{actions.overdue} overdue</Chip> : <span className="text-xs text-secondary-text">None overdue</span>}
        </div>
        <Link to="/Management-Review/Objectives" className="flex flex-col gap-1 rounded-xl border border-border-color bg-primary-bg p-3 hover:border-brand-primary">
          <span className="text-xs text-secondary-text">Quality objectives</span>
          {objectives.total ? (
            <>
              <span className="text-2xl font-semibold tabular-nums text-primary-text">
                {objectives.onTarget} of {objectives.total}
              </span>
              <span className="text-xs text-secondary-text">
                on target{objectives.offTarget ? ` · ${objectives.offTarget} off target` : ""}
                {objectives.noValue ? ` · ${objectives.noValue} with no value yet` : ""}
              </span>
            </>
          ) : (
            <span className="text-secondary-text">None defined</span>
          )}
        </Link>
      </div>
    </Card>
  );
};

export default ManagementReviewCard;
