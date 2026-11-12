import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PlusIcon, PresentationIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import SlidingToggle from "../ui/SlidingToggle";
import { Card } from "../dashboard/DashboardParts";
import { Empty } from "../dashboard/DashboardGraphics";
import { useManagementReviews } from "../../hooks/useManagementReview";
import { describeApiError } from "../../lib/api-client";
import { formatDay, REVIEW_STATUS, reviewPath } from "../../lib/qualityObjectives";
import { PlanReviewDialog } from "./ReviewDialogs";

const FILTERS = [
  { value: "", label: "All" },
  { value: "planned,in_progress", label: "To hold" },
  { value: "completed", label: "Completed" },
];
const th = "py-1 pr-3 text-left text-xs font-medium uppercase tracking-wide";
const td = "py-2 pr-3 align-top";

/** Management reviews (`/Management-Review/Reviews`): those still to hold first, then the latest period. Managers plan a review here. */
const ReviewsPage = () => {
  const [status, setStatus] = useState("");
  const [planning, setPlanning] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error } = useManagementReviews(status || undefined);
  const reviews = data?.data ?? [];

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <PresentationIcon className="h-6 w-6" aria-hidden="true" />
            Management reviews
          </h1>
          <p className="text-sm text-secondary-text">Top management&apos;s review of the quality system, with its inputs gathered for the period, decisions and actions</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <SlidingToggle ariaLabel="Which reviews" options={FILTERS} value={status} onChange={setStatus} />
          {data?.canManage && (
            <CTAButton type="main" onClick={() => setPlanning(true)}>
              <PlusIcon aria-hidden="true" /> Plan a review
            </CTAButton>
          )}
        </div>
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}

      <Card title="Reviews">
        {reviews.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Management reviews">
              <thead className="text-secondary-text">
                <tr>
                  <th className={th}>Review</th>
                  <th className={th}>Period</th>
                  <th className={th}>Held</th>
                  <th className={th}>Status</th>
                  <th className={th}>Sections reviewed</th>
                  <th className={th}>Decisions</th>
                  <th className={th}>Open actions</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((r) => (
                  <tr key={r.id} className="border-t border-border-color">
                    <td className={td}>
                      <Link to={reviewPath(r.id)} className="font-medium text-primary-text hover:underline">
                        {r.reference} · {r.title}
                      </Link>
                      <span className="block text-xs text-secondary-text">Chair: {r.chair.name}</span>
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      {formatDay(r.periodFrom)} – {formatDay(r.periodTo)}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>{r.heldOn ? formatDay(r.heldOn) : r.plannedOn ? `Planned ${formatDay(r.plannedOn)}` : "—"}</td>
                    <td className={td}>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${REVIEW_STATUS[r.status]?.pill ?? ""}`}>{REVIEW_STATUS[r.status]?.label ?? r.status}</span>
                    </td>
                    <td className={`${td} tabular-nums`}>
                      {r.sectionsReviewed} of {r.sections}
                    </td>
                    <td className={`${td} tabular-nums`}>{r.decisionCount}</td>
                    <td className={`${td} tabular-nums`}>{r.openActions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{isLoading ? "Loading…" : data?.canManage ? "No reviews yet. Plan the first one." : "No reviews yet."}</Empty>
        )}
      </Card>

      {planning && <PlanReviewDialog onClose={() => setPlanning(false)} onSaved={(r) => navigate(reviewPath(r.id))} />}
    </div>
  );
};

export default ReviewsPage;
