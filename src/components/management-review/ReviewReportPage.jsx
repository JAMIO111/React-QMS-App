import { useParams } from "react-router-dom";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import DocumentEditor from "../documents/DocumentEditor";
import { useManagementReview } from "../../hooks/useManagementReview";
import { describeApiError } from "../../lib/api-client";
import { decisionCategoryLabel, formatDay, REVIEW_STATUS, reviewPath } from "../../lib/qualityObjectives";
import { SnapshotView } from "./ReviewParts";

const ATTENDANCE_WORDS = { invited: "invited", present: "present", apologies: "apologies" };

/** The whole management review as one printable document (`/Management-Review/Reviews/:id/report`). "Print or save as PDF" prints only the report. */
const ReviewReportPage = () => {
  const { id } = useParams();
  const { data: r, isLoading, error } = useManagementReview(id);
  if (isLoading) return <LoadingScreen />;
  if (error || !r)
    return (
      <div className="p-4">
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      </div>
    );
  const h2 = "mt-6 border-b border-border-color pb-1 text-lg font-semibold text-primary-text";
  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <style>{"@media print { body * { visibility: hidden !important; } #review-report, #review-report * { visibility: visible !important; } #review-report { position: absolute; left: 0; top: 0; width: 100%; margin: 0; padding: 0; box-shadow: none; } }"}</style>
      <div className="flex flex-wrap gap-2">
        <CTAButton type="neutral" size="md" to={reviewPath(r.id)}>
          Back to the review
        </CTAButton>
        <CTAButton buttonType="button" type="secondary" size="md" onClick={() => window.print()}>
          Print or save as PDF
        </CTAButton>
      </div>
      <article id="review-report" aria-label="Management review report" className="mx-auto w-full max-w-4xl rounded-2xl bg-secondary-bg p-8 text-sm text-primary-text shadow">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">
            {r.reference} · {r.title}
          </h1>
          <p className="text-secondary-text">
            {REVIEW_STATUS[r.status]?.label} · reviews {formatDay(r.periodFrom)} – {formatDay(r.periodTo)} · chaired by {r.chair.name}
            {r.heldOn ? ` · held ${formatDay(r.heldOn)}` : ""}
            {r.completedAt ? ` · completed ${formatDay(r.completedAt)}${r.completedBy ? ` by ${r.completedBy}` : ""}` : ""}
          </p>
          {r.status !== "completed" && <p className="font-medium text-warning-color">Not completed: this is a draft of the record.</p>}
        </header>

        <h2 className={h2}>Attendees</h2>
        {r.attendees.length ? (
          <ul className="mt-2 list-disc pl-5">
            {r.attendees.map((a) => (
              <li key={a.id}>
                {a.name}
                {a.role ? `, ${a.role}` : ""}
                {a.outsider ? " (from outside)" : ""} — {ATTENDANCE_WORDS[a.attendance]}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-secondary-text">None recorded.</p>
        )}

        <h2 className={h2}>Inputs</h2>
        {r.inputs.map((i) => (
          <section key={i.id} aria-label={i.title} className="mt-4 break-inside-avoid">
            <h3 className="mb-2 font-semibold">
              {i.title}
              {!i.reviewed && <span className="ml-2 text-xs font-normal text-warning-color">not reviewed</span>}
            </h3>
            {i.available === false && <p className="text-secondary-text">Not available to the person who gathered it.</p>}
            <SnapshotView snapshot={i.snapshot} />
            {i.commentary && <p className="mt-2 whitespace-pre-line">{i.commentary}</p>}
          </section>
        ))}

        {r.minutes && (
          <>
            <h2 className={h2}>Minutes</h2>
            <div className="mt-2">
              <DocumentEditor value={r.minutes} editable={false} label="Minutes" />
            </div>
          </>
        )}

        <h2 className={h2}>Decisions</h2>
        {r.decisions.length ? (
          <ol className="mt-2 list-decimal pl-5">
            {r.decisions.map((d) => (
              <li key={d.id} className="mb-1">
                {d.description} <span className="text-secondary-text">({decisionCategoryLabel(d.category)})</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-secondary-text">{r.noDecisionNote ? `No decision was needed: ${r.noDecisionNote}` : "None recorded."}</p>
        )}

        <h2 className={h2}>Actions</h2>
        {r.actions.length ? (
          <table className="mt-2 w-full" aria-label="Actions">
            <thead className="text-left text-xs uppercase text-secondary-text">
              <tr>
                <th className="py-1 pr-3">Action</th>
                <th className="py-1 pr-3">Given to</th>
                <th className="py-1 pr-3">Due</th>
                <th className="py-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {r.actions.map((a) => (
                <tr key={a.id} className="border-t border-border-color align-top">
                  <td className="py-1 pr-3">{a.description}</td>
                  <td className="py-1 pr-3">{a.owner.name}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">{a.dueDate ? formatDay(a.dueDate) : "—"}</td>
                  <td className="py-1">
                    {a.status}
                    {a.doneNote ? `: ${a.doneNote}` : ""}
                    {a.cancelReason ? `: ${a.cancelReason}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-2 text-secondary-text">None.</p>
        )}
      </article>
    </div>
  );
};

export default ReviewReportPage;
