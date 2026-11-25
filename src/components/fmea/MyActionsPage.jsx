import { useState } from "react";
import { Link } from "react-router-dom";
import CTAButton from "@/components/CTAButton";
import { CheckIcon, ListTreeIcon, RotateCcwIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import Callout from "../ui/Callout";
import SlidingToggle from "../ui/SlidingToggle";
import { Card } from "../dashboard/DashboardParts";
import { Chip, Empty } from "../dashboard/DashboardGraphics";
import { useFmeaActionMutation, useFmeaModel, useMyFmeaActions } from "../../hooks/useFmea";
import { describeApiError } from "../../lib/api-client";
import { actionKindLabel, actionStatusLabel, dueWords, priorityLabel, revisionPath } from "../../lib/fmea";
import { CompleteActionDialog } from "./ActionDialogs";

const STATUS_CHOICES = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
  { value: "all", label: "All" },
];

/**
 * My FMEA actions (`/FMEA/My-Actions`, menu badge "my-fmea-actions"): the actions given to me on any FMEA that is a draft or in force. I can finish mine, or reopen one I
 * finished that has not been taken into a revision, with only the right to read FMEAs; what an action is, who has it and when it is due belong to the team that manages the FMEA.
 */
const MyActionsPage = () => {
  const [status, setStatus] = useState("open");
  const { data, isLoading, error } = useMyFmeaActions(status);
  const mutation = useFmeaActionMutation();
  const [finishing, setFinishing] = useState(null);
  const model = useFmeaModel();
  const actions = data?.data ?? [];

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <ListTreeIcon className="h-6 w-6" aria-hidden="true" />
            My FMEA actions
          </h1>
          <p className="text-sm text-secondary-text">Actions the FMEA team has given to you: finish one with what you found, and the rating it brings the cause to</p>
        </div>
        <SlidingToggle ariaLabel="Which actions" options={STATUS_CHOICES} value={status} onChange={setStatus} />
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}
      {mutation.error && (
        <Callout tone="error" role="alert">
          {describeApiError(mutation.error)}
        </Callout>
      )}
      {data && data.openCount === 0 && status === "open" && <Callout tone="success">Nothing is waiting for you at the moment.</Callout>}
      {data?.overdueCount > 0 && (
        <Callout tone="warning">
          {data.overdueCount} {data.overdueCount === 1 ? "action is" : "actions are"} late.
        </Callout>
      )}

      <Card title="Actions" subtitle="Most urgent first">
        {actions.length === 0 ? (
          <Empty>{isLoading ? "Loading…" : status === "open" ? "No open actions." : "Nothing here."}</Empty>
        ) : (
          <ul aria-label="My FMEA actions" className="flex flex-col divide-y divide-border-color text-sm">
            {actions.map((a) => {
              const late = a.status === "open" && String(a.dueOn) < new Date().toLocaleDateString("en-CA");
              return (
                <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="text-primary-text">
                      <Chip tone="info">{actionKindLabel(a.kind)}</Chip> <span className="ml-1">{a.description}</span>
                    </p>
                    <p className="text-xs text-secondary-text">
                      {a.revisionStatus === "draft" ? (
                        <>
                          {a.fmeaNumber} · {a.fmeaTitle} (draft)
                        </>
                      ) : (
                        <Link to={revisionPath(a.fmeaId, a.revisionId)} className="hover:underline">
                          {a.fmeaNumber} · {a.fmeaTitle}
                          {a.revisionLetter ? ` · rev ${a.revisionLetter}` : ""}
                        </Link>
                      )}{" "}
                      · {a.causeText ? `Cause: ${a.causeText}` : ""}
                    </p>
                    <p className={`text-xs ${late ? "font-medium text-error-color" : "text-secondary-text"}`}>{dueWords({ dueOn: a.dueOn, overdue: late })}</p>
                    {a.status === "done" && (
                      <p className="text-xs text-secondary-text">
                        {actionStatusLabel(a.status)}: <span className="text-primary-text">{a.evidenceNote}</span>
                        {a.revisedRpn != null && <> · Comes to RPN {a.revisedRpn} · {priorityLabel(a.revisedPriority)}</>}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {a.status === "open" && (
                      <CTAButton type="success" icon={CheckIcon} onClick={() => setFinishing(a)}>
                        Finish
                      </CTAButton>
                    )}
                    {a.status === "done" && !a.adopted && (
                      <CTAButton type="neutral" icon={RotateCcwIcon} loading={mutation.isPending && mutation.variables?.id === a.id} onClick={() => mutation.mutate({ action: "reopen", id: a.id })}>
                        Reopen
                      </CTAButton>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {finishing && (
        <CompleteActionDialog
          action={finishing}
          cause={finishing.causeText ? { text: finishing.causeText, occurrence: finishing.occurrence, detection: finishing.detection } : null}
          scale={model.data?.config?.scales?.[finishing.fmeaKind] ?? null}
          onClose={() => setFinishing(null)}
        />
      )}
    </div>
  );
};

export default MyActionsPage;
