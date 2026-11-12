import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PresentationIcon, PrinterIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import { Card } from "../dashboard/DashboardParts";
import DocumentEditor from "../documents/DocumentEditor";
import { useManagementReview, useReviewMutation } from "../../hooks/useManagementReview";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { todayIso } from "../../lib/localDate";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { decisionCategoryLabel, formatDay, REVIEW_STATUS, reviewPath } from "../../lib/qualityObjectives";
import { InputCard } from "./ReviewParts";
import { ActionDialog, AttendeesDialog, DecisionDialog, PlanReviewDialog, TextDialog } from "./ReviewDialogs";

const ATTENDANCE_WORDS = { invited: "Invited", present: "Present", apologies: "Apologies" };
const ACTION_STATUS = { open: "Open", done: "Done", cancelled: "Cancelled" };

/**
 * One management review (`/Management-Review/Reviews/:id`). Planned: details and attendees. Started: every input section gathered for the period (as the person who
 * started it) with commentary and "reviewed", attendance, minutes, decisions and actions; Complete when nothing is still needed. Completed: everything frozen
 * (actions can still be closed). A printable report is at `…/report`.
 */
const ReviewPage = () => {
  const { id } = useParams();
  const { data: r, isLoading, error } = useManagementReview(id);
  const mutation = useReviewMutation();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null);
  const [gathering, setGathering] = useState(null);
  useBreadcrumbNames([
    { path: reviewPath(id), label: r ? r.reference : null },
    { path: "/Management-Review", label: "Management review", to: "/Management-Review/Reviews" },
  ]);

  if (isLoading) return <LoadingScreen />;
  if (error || !r)
    return (
      <div className="p-4">
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      </div>
    );

  const run = (command, failed = "Not saved", onSettled) =>
    mutation.mutate(command, { onSettled, onError: (err) => showToast({ type: "error", title: failed, message: describeApiError(err) }) });
  const gather = (section) => {
    setGathering(section ?? "all");
    run({ action: "gather", id: r.id, body: section ? { sections: [section] } : {} }, "Not gathered", () => setGathering(null));
  };
  const saveMinutes = (minutes) => new Promise((resolve, reject) => mutation.mutate({ action: "setMinutes", id: r.id, body: { minutes } }, { onSuccess: resolve, onError: reject }));
  const reviewed = r.inputs.filter((i) => i.reviewed).length;
  const present = r.attendees.filter((a) => a.attendance === "present").length;

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold text-primary-text">
            <PresentationIcon className="h-6 w-6" aria-hidden="true" />
            {r.reference} · {r.title}
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${REVIEW_STATUS[r.status]?.pill ?? ""}`}>{REVIEW_STATUS[r.status]?.label}</span>
          </h1>
          <p className="text-sm text-secondary-text">
            Reviews {formatDay(r.periodFrom)} – {formatDay(r.periodTo)} · chaired by {r.chair.name} · {r.heldOn ? `held ${formatDay(r.heldOn)}` : r.plannedOn ? `planned for ${formatDay(r.plannedOn)}` : "not yet dated"}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <CTAButton type="secondary" to={`${reviewPath(r.id)}/report`}>
            <PrinterIcon aria-hidden="true" /> Report
          </CTAButton>
          {r.canEdit && (
            <CTAButton type="neutral" onClick={() => setDialog({ kind: "edit" })}>
              Edit
            </CTAButton>
          )}
          {r.canManage && r.status === "planned" && (
            <CTAButton type="main" loading={mutation.isPending && mutation.variables?.action === "start"} onClick={() => run({ action: "start", id: r.id }, "Not started")}>
              Start the review
            </CTAButton>
          )}
          {r.canHold && (
            <CTAButton type="main" disabled={r.problems.some((p) => !p.startsWith("Record a decision"))} onClick={() => setDialog({ kind: r.decisions.length ? "complete" : "completeNone" })}>
              Complete
            </CTAButton>
          )}
          {r.canEdit && (
            <CTAButton type="danger" onClick={() => setDialog({ kind: "cancel" })}>
              Cancel
            </CTAButton>
          )}
        </div>
      </div>

      {r.status === "completed" && (
        <Callout tone="success" title="Completed">
          Completed {r.completedAt ? formatDay(r.completedAt) : ""}
          {r.completedBy ? ` by ${r.completedBy}` : ""}. The record is frozen; its actions can still be closed.
          {r.noDecisionNote ? ` No decision was needed: ${r.noDecisionNote}` : ""}
        </Callout>
      )}
      {r.status === "cancelled" && (
        <Callout tone="warning" title="Cancelled">
          {r.cancelReason}
        </Callout>
      )}
      {r.status === "planned" && r.canManage && <Callout tone="info">Starting the review gathers every input for its period from the modules you may read. You can gather any section again while it is held.</Callout>}
      {r.status === "in_progress" && r.problems.length > 0 && (
        <Callout tone="warning" title="Still needed to complete">
          <ul className="list-disc pl-5">
            {r.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Callout>
      )}

      <Card
        title="Attendees"
        subtitle={r.attendees.length ? `${present} present` : "No one listed yet"}
        action={
          r.canEdit && (
            <CTAButton type="neutral" onClick={() => setDialog({ kind: "attendees" })}>
              Change
            </CTAButton>
          )
        }>
        {r.attendees.length > 0 && (
          <ul aria-label="Attendees" className="flex flex-wrap gap-2 text-sm">
            {r.attendees.map((a) => (
              <li key={a.id} className="rounded-full border border-border-color px-3 py-1">
                <span className="font-medium text-primary-text">{a.name}</span>
                {a.role && <span className="text-secondary-text"> · {a.role}</span>}
                {a.outsider && <span className="text-secondary-text"> · from outside</span>}
                <span className="text-secondary-text"> · {ATTENDANCE_WORDS[a.attendance]}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {r.status !== "planned" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-xl font-semibold text-primary-text">Inputs</h2>
            <span className="text-sm text-secondary-text">
              {reviewed} of {r.inputs.length} reviewed
              {r.canHold && (
                <CTAButton type="neutral" className="ml-3" loading={gathering === "all"} onClick={() => gather()}>
                  Gather everything again
                </CTAButton>
              )}
            </span>
          </div>
          {r.inputs.map((i) => (
            <InputCard key={i.id} review={r} input={i} onGather={gather} gathering={gathering === i.section} />
          ))}
        </div>
      )}

      {r.status !== "planned" && (
        <Card title="Minutes" subtitle={r.canHold ? "Saved as you type" : undefined}>
          {r.canHold || r.minutes ? <DocumentEditor key={r.status} value={r.minutes} editable={r.canHold} onChange={saveMinutes} label="Minutes" /> : <p className="text-sm text-secondary-text">No minutes were written.</p>}
        </Card>
      )}

      {r.status !== "planned" && (
        <Card
          title="Decisions"
          action={
            r.canHold && (
              <CTAButton type="neutral" onClick={() => setDialog({ kind: "decision" })}>
                Record a decision
              </CTAButton>
            )
          }>
          {r.decisions.length ? (
            <ul aria-label="Decisions" className="flex flex-col divide-y divide-border-color text-sm">
              {r.decisions.map((d) => (
                <li key={d.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="block whitespace-pre-line text-primary-text">{d.description}</span>
                    <span className="text-xs text-secondary-text">{decisionCategoryLabel(d.category)}</span>
                  </span>
                  {r.canHold && (
                    <span className="flex gap-2">
                      <CTAButton type="neutral" onClick={() => setDialog({ kind: "decision", decision: d })}>
                        Edit
                      </CTAButton>
                      <CTAButton type="danger" disabled={r.actions.some((a) => a.decisionId === d.id)} onClick={() => run({ action: "removeDecision", id: d.id }, "Not removed")}>
                        Remove
                      </CTAButton>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-secondary-text">{r.noDecisionNote ? `None: ${r.noDecisionNote}` : "No decisions yet."}</p>
          )}
        </Card>
      )}

      {r.status !== "planned" && (
        <Card
          title="Actions"
          action={
            r.canHold && (
              <CTAButton type="neutral" onClick={() => setDialog({ kind: "action" })}>
                Give an action
              </CTAButton>
            )
          }>
          {r.actions.length ? (
            <ul aria-label="Actions" className="flex flex-col divide-y divide-border-color text-sm">
              {r.actions.map((a) => {
                const decision = r.decisions.find((d) => d.id === a.decisionId);
                const late = a.status === "open" && a.dueDate && a.dueDate < todayIso();
                return (
                  <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="block text-primary-text">{a.description}</span>
                      <span className="text-xs text-secondary-text">
                        {a.owner.name}
                        {a.dueDate ? ` · due ${formatDay(a.dueDate)}` : ""}
                        {late ? " · overdue" : ""} · {ACTION_STATUS[a.status]}
                        {decision ? ` · from "${decision.description.slice(0, 60)}"` : ""}
                      </span>
                      {a.doneNote && <span className="block text-xs text-secondary-text">Done: {a.doneNote}</span>}
                      {a.cancelReason && <span className="block text-xs text-secondary-text">Cancelled: {a.cancelReason}</span>}
                    </span>
                    {r.status !== "cancelled" && (
                      <span className="flex flex-wrap gap-2">
                        {a.status === "open" && (r.canManage || a.mine) && (
                          <CTAButton type="secondary" onClick={() => setDialog({ kind: "doneAction", action: a })}>
                            Mark done
                          </CTAButton>
                        )}
                        {a.status === "open" && r.canManage && (
                          <>
                            <CTAButton type="neutral" onClick={() => setDialog({ kind: "action", action: a })}>
                              Change
                            </CTAButton>
                            <CTAButton type="danger" onClick={() => setDialog({ kind: "cancelAction", action: a })}>
                              Cancel
                            </CTAButton>
                          </>
                        )}
                        {a.status !== "open" && r.canManage && (
                          <CTAButton type="neutral" onClick={() => run({ action: "reopenAction", id: a.id }, "Not reopened")}>
                            Reopen
                          </CTAButton>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-secondary-text">No actions.</p>
          )}
        </Card>
      )}

      {r.status === "completed" && (
        <p className="text-sm">
          <Link to="/Management-Review/Reviews" className="text-secondary-text hover:underline">
            All reviews
          </Link>
        </p>
      )}

      {dialog?.kind === "edit" && <PlanReviewDialog existing={r} onClose={() => setDialog(null)} />}
      {dialog?.kind === "attendees" && <AttendeesDialog review={r} onClose={() => setDialog(null)} />}
      {dialog?.kind === "decision" && <DecisionDialog review={r} existing={dialog.decision} onClose={() => setDialog(null)} />}
      {dialog?.kind === "action" && <ActionDialog review={r} existing={dialog.action} onClose={() => setDialog(null)} />}
      {dialog?.kind === "doneAction" && (
        <TextDialog title="Mark the action done" intro={dialog.action.description} label="What was done" field="note" min={1} max={2000} confirm="Mark done" command={{ action: "completeAction", id: dialog.action.id }} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "cancelAction" && (
        <TextDialog title="Cancel the action" intro={dialog.action.description} label="Why is it cancelled?" confirm="Cancel the action" type="danger" command={{ action: "cancelAction", id: dialog.action.id }} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "complete" && (
        <TextDialog
          title={`Complete ${r.reference}`}
          intro="Once completed, the review is the frozen record: its inputs, commentary, attendees, minutes and decisions no longer change. Actions can still be closed."
          confirm="Complete the review"
          command={{ action: "complete", id: r.id }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "completeNone" && (
        <TextDialog
          title={`Complete ${r.reference} with no decision`}
          intro="No decision was recorded. Say why none was needed; the review is then the frozen record."
          label="Why no decision was needed"
          field="noDecisionNote"
          max={1000}
          confirm="Complete the review"
          command={{ action: "complete", id: r.id }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "cancel" && (
        <TextDialog title={`Cancel ${r.reference}`} intro="Its open actions are cancelled with it. Nothing is deleted." label="Why is it cancelled?" confirm="Cancel the review" type="danger" command={{ action: "cancel", id: r.id }} onClose={() => setDialog(null)} />
      )}
    </div>
  );
};

export default ReviewPage;
