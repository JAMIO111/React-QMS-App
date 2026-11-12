import { useState } from "react";
import { Link } from "react-router-dom";
import { ListTodoIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import SlidingToggle from "../ui/SlidingToggle";
import { Card } from "../dashboard/DashboardParts";
import { Chip, Empty } from "../dashboard/DashboardGraphics";
import { FormError, TextAreaField } from "../master-data/shared";
import { useToast } from "../../contexts/ToastProvider";
import { useMyTasks, useTaskMutation } from "../../hooks/useWorkflows";
import { describeApiError } from "../../lib/api-client";
import { dueWords } from "../../lib/workflows";

const STATUS = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
  { value: "all", label: "All" },
];

/** Close a task, with an optional note of what was done. The task leaves the list at once and comes back if the server refuses. */
const CompleteDialog = ({ task, onClose }) => {
  const mutation = useTaskMutation();
  const { showToast } = useToast();
  const [note, setNote] = useState("");
  return (
    <Dialog title="Mark the task done" onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
          mutation.mutate(
            { action: "complete", id: task.id, body: note.trim() ? { note: note.trim() } : {} },
            { onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) },
          );
        }}
      >
        <p className="text-sm text-secondary-text">{task.title}</p>
        <TextAreaField label="What was done (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md">
            Mark done
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/**
 * My tasks (`/Tasks`): tasks workflow rules gave the signed-in person, each naming the record it is about and the rule that made it. Open to every member —
 * whoever a rule names may hold no workflow permission. Task notices lead here.
 */
const MyTasksPage = () => {
  const [status, setStatus] = useState("open");
  const [completing, setCompleting] = useState(null);
  const { data, isLoading, error } = useMyTasks(status);
  const reopen = useTaskMutation();
  const { showToast } = useToast();

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <ListTodoIcon className="h-6 w-6" aria-hidden="true" />
            My tasks
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            {data ? `${data.openCount} open${data.overdueCount ? ` · ${data.overdueCount} overdue` : ""}` : "Tasks workflow rules gave you"}
          </p>
        </div>
        <SlidingToggle ariaLabel="Which tasks" options={STATUS} value={status} onChange={setStatus} />
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}

      <Card title="Tasks">
        {data?.data?.length ? (
          <ul aria-label="My tasks" className="flex flex-col divide-y divide-border-color text-sm">
            {data.data.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium text-primary-text">
                    <span className="mr-2 text-xs text-secondary-text tabular-nums">{t.reference}</span>
                    {t.title}
                  </span>
                  {t.detail && <span className="text-xs whitespace-pre-line text-secondary-text">{t.detail}</span>}
                  <span className="text-xs text-secondary-text">
                    {t.record?.path ? (
                      <Link to={t.record.path} className="hover:underline">
                        {t.record.label}
                      </Link>
                    ) : (
                      t.record?.label
                    )}
                    {t.ruleName ? ` · from the rule “${t.ruleName}”` : ""}
                    {dueWords(t.dueOn) ? ` · ${dueWords(t.dueOn)}` : ""}
                  </span>
                  {t.doneNote && <span className="text-xs text-secondary-text">Done: {t.doneNote}</span>}
                </span>
                <span className="flex items-center gap-2">
                  {t.overdue && t.status === "open" && <Chip tone="error">overdue</Chip>}
                  {t.status === "cancelled" && <Chip>cancelled</Chip>}
                  {t.status === "open" && (
                    <CTAButton type="secondary" onClick={() => setCompleting(t)} aria-label={`Mark done: ${t.title}`}>
                      Mark done
                    </CTAButton>
                  )}
                  {t.status === "done" && (
                    <CTAButton
                      type="neutral"
                      aria-label={`Reopen: ${t.title}`}
                      onClick={() => reopen.mutate({ action: "reopen", id: t.id }, { onError: (err) => showToast({ type: "error", title: "Not reopened", message: describeApiError(err) }) })}
                    >
                      Reopen
                    </CTAButton>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{isLoading ? "Loading…" : status === "open" ? "No task is waiting for you." : "Nothing here."}</Empty>
        )}
      </Card>

      {completing && <CompleteDialog task={completing} onClose={() => setCompleting(null)} />}
    </div>
  );
};

export default MyTasksPage;
