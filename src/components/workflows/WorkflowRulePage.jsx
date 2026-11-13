import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { WorkflowIcon } from "@/components/icons";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import { FormError, TextAreaField } from "../master-data/shared";
import { useToast } from "../../contexts/ToastProvider";
import { useWorkflowRule, useWorkflowRuleMutation, useWorkflowTriggers } from "../../hooks/useWorkflows";
import { usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { RUN_STATUS, when, contentChanged, describeAction, describeCondition, draftFromRule, draftProblems, emptyDraft, ruleContent, workflowRulePath } from "../../lib/workflows";
import RuleBuilder from "./RuleBuilder";
import RuleTest from "./RuleTest";
import { RuleStatusPill } from "./WorkflowsPage";

/** Asks for one piece of text (a reason) before a command. */
const ReasonDialog = ({ title, intro, label, confirm, pending, error, onConfirm, onClose }) => {
  const [text, setText] = useState("");
  const ok = text.trim().length >= 3;
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onConfirm(text.trim());
        }}
      >
        {intro && <p className="text-sm text-secondary-text">{intro}</p>}
        <TextAreaField label={label} value={text} onChange={(e) => setText(e.target.value)} required maxLength={1000} rows={3} />
        <FormError error={error} />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!ok} loading={pending}>
            {confirm}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const runSummary = (run) =>
  Object.entries(run.results ?? {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([i, r]) => {
      const n = Number(i) + 1;
      if (r.waiting) return `${n}: waiting until ${when(r.due)}`;
      if (r.fired) {
        if (r.stopped) return `${n}: timer stopped — ${r.stopped.toLowerCase()}`;
        if (r.still === false) return `${n}: timer ran; no longer needed`;
        if (r.error) return `${n}: timer failed — ${r.error}`;
        return `${n}: timer ran; ${(r.results ?? []).length} thing${(r.results ?? []).length === 1 ? "" : "s"} done`;
      }
      if (r.held) return `${n}: lot ${r.lot} put on hold`;
      if (r.refused) return `${n}: lot ${r.lot ?? ""} not held — ${r.refused}`;
      if (r.reference) return `${n}: task ${r.reference}${r.created === false ? " (already given)" : ""}`;
      if (typeof r.told === "number") return `${n}: told ${r.told}${r.skipped ? `, ${r.skipped} may not read it` : ""}`;
      if (r.skipped) return `${n}: ${typeof r.skipped === "string" ? r.skipped.toLowerCase() : "skipped"}`;
      if (r.error) return `${n}: failed — ${r.error}`;
      return `${n}: ${r.ok ? "done" : "failed"}`;
    })
    .join(" · ");

/**
 * One rule (`/Settings/Workflows/:id`, `new` writes one): the builder, testing against a recent event, pausing / retiring, every version with its reason, and the
 * latest runs (which version did what, for which record). Without workflows.manage everything is read-only.
 */
const WorkflowRulePage = () => {
  const { id } = useParams();
  const isNew = id === "new";
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { can, isLoading: permissionsLoading } = usePermissions();
  const triggers = useWorkflowTriggers();
  const rule = useWorkflowRule(isNew ? null : id);
  const mutation = useWorkflowRuleMutation();
  const [draft, setDraft] = useState(emptyDraft);
  const [labels, setLabels] = useState({});
  const [loadedFor, setLoadedFor] = useState(null);
  const [dialog, setDialog] = useState(null);

  // Load the saved rule into the builder once per rule (and again after each save).
  const savedAt = rule.data ? `${rule.data.id}:${rule.data.version}:${rule.data.name}:${rule.data.description ?? ""}:${rule.data.status}` : null;
  useEffect(() => {
    if (rule.data && savedAt !== loadedFor) {
      setDraft(draftFromRule(rule.data));
      setLabels((l) => ({ ...l, ...(rule.data.labels ?? {}) }));
      setLoadedFor(savedAt);
    }
  }, [rule.data, savedAt, loadedFor]);

  const list = triggers.data ?? [];
  const trigger = list.find((t) => t.eventType === draft.trigger);
  const canManage = can("workflows.manage");
  const retired = rule.data?.status === "retired";
  const editable = canManage && !retired;
  const problems = draftProblems(draft, trigger);
  const changed = isNew || contentChanged(draft, rule.data);
  const detailsChanged = !isNew && rule.data && (draft.name.trim() !== rule.data.name || (draft.description.trim() || null) !== (rule.data.description ?? null));
  const dirty = isNew || changed || detailsChanged;
  const onLabel = (key, name) => setLabels((l) => (l[key] === name ? l : { ...l, [key]: name }));

  const run = (command, done) =>
    mutation.mutate(command, {
      onSuccess: (saved) => {
        setDialog(null);
        done?.(saved);
      },
      onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
    });

  const save = (reason) => {
    const details = { name: draft.name.trim(), description: draft.description.trim() || (isNew ? undefined : null) };
    if (isNew) {
      run({ action: "create", body: { ...details, ...ruleContent(draft) } }, (saved) => {
        showToast({ type: "success", title: "Rule saved", message: `${saved.reference} is on and runs from now.` });
        navigate(workflowRulePath(saved.id), { replace: true });
      });
      return;
    }
    const body = changed ? { ...details, ...ruleContent(draft), reason } : details;
    run({ action: "update", id, body }, (saved) => showToast({ type: "success", title: "Rule saved", message: changed ? `Version ${saved.version} runs from now.` : "Details saved." }));
  };

  if (!isNew && rule.error) {
    return (
      <Callout tone="error" role="alert">
        {describeApiError(rule.error)}
      </Callout>
    );
  }
  if (isNew && !permissionsLoading && !canManage) {
    return <Callout tone="warning">Only people who manage workflows can write rules.</Callout>;
  }
  if ((!isNew && !rule.data) || triggers.isLoading) return <p className="text-sm text-secondary-text">Loading…</p>;

  const r = rule.data;
  const triggerLabel = (key) => list.find((t) => t.eventType === key)?.label ?? key;
  const triggerOf = (key) => list.find((t) => t.eventType === key);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link to="/Settings/Workflows" className="text-sm text-secondary-text hover:underline">
            ← Workflows
          </Link>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <WorkflowIcon aria-hidden="true" />
            {isNew ? "New rule" : r.name}
          </h1>
          {!isNew && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-secondary-text">
              {r.reference} · version {r.version} <RuleStatusPill status={r.status} />
            </p>
          )}
        </div>
        {!isNew && canManage && (
          <div className="flex flex-wrap gap-2">
            {r.status === "active" && (
              <CTAButton type="neutral" loading={mutation.isPending && mutation.variables?.action === "status"} onClick={() => run({ action: "status", id, body: { status: "paused" } })}>
                Pause
              </CTAButton>
            )}
            {r.status === "paused" && (
              <CTAButton type="secondary" loading={mutation.isPending && mutation.variables?.action === "status"} onClick={() => run({ action: "status", id, body: { status: "active" } })}>
                Resume
              </CTAButton>
            )}
            {r.status !== "retired" ? (
              <CTAButton type="danger" onClick={() => setDialog("retire")}>
                Retire
              </CTAButton>
            ) : (
              <CTAButton type="secondary" loading={mutation.isPending && mutation.variables?.action === "status"} onClick={() => run({ action: "status", id, body: { status: "active" } })}>
                Bring back
              </CTAButton>
            )}
          </div>
        )}
      </div>

      {r?.status === "paused" && <Callout tone="warning">This rule is paused: it does not run until it is resumed.</Callout>}
      {retired && <Callout tone="info" title="Retired">{r.statusReason}</Callout>}

      <MenuCard
        as="form"
        noValidate
        title="What the rule does"
        subtitle={editable ? "A change to what starts it, what it tests or what it does is saved as a new version, with a reason." : undefined}
        onSubmit={(e) => {
          e.preventDefault();
          if (problems.length || !dirty) return;
          if (!isNew && changed) setDialog("reason");
          else save();
        }}
      >
        <RuleBuilder draft={draft} setDraft={setDraft} triggers={list} labels={labels} onLabel={onLabel} disabled={!editable} />
        {editable && (
          <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-border-color pt-4">
            {problems.length > 0 ? (
              <p className="mr-auto text-sm text-secondary-text" role="status">
                Still needed: {problems[0].charAt(0).toLowerCase() + problems[0].slice(1)}
                {problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""}
              </p>
            ) : !isNew && changed ? (
              <p className="mr-auto text-sm text-secondary-text" role="status">
                This will be version {r.version + 1}.
              </p>
            ) : null}
            {!isNew && dirty && (
              <CTAButton type="neutral" size="md" onClick={() => setDraft(draftFromRule(r))}>
                Discard changes
              </CTAButton>
            )}
            <CTAButton buttonType="submit" type="main" size="lg" disabled={problems.length > 0 || !dirty} loading={mutation.isPending && mutation.variables?.action !== "status"}>
              {isNew ? "Save and turn on" : "Save"}
            </CTAButton>
          </div>
        )}
      </MenuCard>

      {canManage && !retired && <RuleTest draft={draft} problems={problems} labels={labels} trigger={trigger} />}

      {!isNew && (
        <>
          <MenuCard title="What it did" subtitle="The latest runs, newest first: which version ran, for which record, and what each action did.">
            {r.runs.length ? (
              <ul className="flex flex-col divide-y divide-border-color text-sm" aria-label="Runs">
                {r.runs.map((w) => (
                  <li key={w.id} className="flex flex-col gap-0.5 py-2">
                    <span className="flex flex-wrap items-center gap-2 text-primary-text">
                      {w.record.path ? (
                        <Link to={w.record.path} className="font-medium hover:underline">
                          {w.record.label}
                        </Link>
                      ) : (
                        <span className="font-medium">{w.record.label}</span>
                      )}
                      <span className="text-xs text-secondary-text">
                        {when(w.at)} · version {w.version} · {RUN_STATUS[w.status] ?? w.status}
                      </span>
                    </span>
                    {Object.keys(w.results ?? {}).length > 0 && <span className="text-xs text-secondary-text">{runSummary(w)}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-secondary-text">It has not run yet.</p>
            )}
          </MenuCard>

          <MenuCard title="Versions" subtitle="What the rule did at each version, and why it changed.">
            <ol className="flex flex-col gap-3 text-sm" aria-label="Versions">
              {r.versions.map((v) => (
                <li key={v.version} className="rounded-xl border border-border-color p-3">
                  <p className="font-medium text-primary-text">
                    Version {v.version}
                    {v.version === r.version ? " (in use)" : ""}
                    <span className="font-normal text-secondary-text">
                      {" "}
                      · {when(v.at)}
                      {v.by ? ` · ${v.by}` : ""}
                    </span>
                  </p>
                  {v.reason && <p className="text-secondary-text">Why: {v.reason}</p>}
                  <p className="mt-1 text-primary-text">When {triggerLabel(v.trigger).charAt(0).toLowerCase() + triggerLabel(v.trigger).slice(1)}</p>
                  {[...(v.conditions?.all ?? []), ...(v.conditions?.any ?? [])].length > 0 && (
                    <p className="text-primary-text">
                      if {v.conditions?.any?.length ? "any of: " : ""}
                      {[...(v.conditions?.all ?? []), ...(v.conditions?.any ?? [])].map((c) => describeCondition(c, triggerOf(v.trigger), labels)).join(v.conditions?.any?.length ? "; " : " and ")}
                    </p>
                  )}
                  <ul className="list-disc pl-5 text-primary-text">
                    {v.actions.map((a, i) => (
                      <li key={i}>{describeAction(a, labels, triggerOf(v.trigger))}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </MenuCard>
        </>
      )}

      {dialog === "reason" && (
        <ReasonDialog
          title={`Save as version ${r.version + 1}`}
          intro="What the rule does is changing. The reason is kept with the version, so its history says why."
          label="Why is this changing?"
          confirm="Save"
          pending={mutation.isPending}
          error={mutation.error}
          onConfirm={save}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "retire" && (
        <ReasonDialog
          title="Retire this rule"
          intro="A retired rule never runs. Its versions and runs are kept, and it can be brought back."
          label="Why is it being retired?"
          confirm="Retire"
          pending={mutation.isPending}
          error={mutation.error}
          onConfirm={(reason) => run({ action: "status", id, body: { status: "retired", reason } })}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
};

export default WorkflowRulePage;
