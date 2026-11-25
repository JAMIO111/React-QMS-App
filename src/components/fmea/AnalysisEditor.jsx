import { useState } from "react";
import { Link } from "react-router-dom";
import CTAButton from "@/components/CTAButton";
import { CheckIcon, LinkIcon, PencilIcon, PlusIcon, RotateCcwIcon, Trash2Icon, TriangleAlertIcon, XIcon } from "@/components/icons";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useFmeaActionMutation, useFmeaNodeMutation } from "../../hooks/useFmea";
import { actionKindLabel, actionStatusLabel, actionStatusPill, CHILD_KINDS, controlKindLabel, dueWords, linkStateLabel, linkStatePill, planTargetWords, elementTypeLabel, effectLevelLabel, fmeaPath, itemKindLabel, modelWords, priorityLabel, priorityPill, ratingWords, revisedWords, revisionPath, specialClassLabel, topKinds, worstSeverity } from "../../lib/fmea";
import { FormError } from "../master-data/shared";
import Callout from "../ui/Callout";
import MenuCard from "../ui/MenuCard";
import RowActionsMenu from "../ui/RowActionsMenu";
import { ActionDialog, CancelActionDialog, CompleteActionDialog } from "./ActionDialogs";
import { CauseDialog, EffectDialog, FailureModeDialog, FunctionDialog, ItemDialog } from "./AnalysisDialogs";
import { CarryDialog, EndLinkDialog } from "./ControlDialogs";

const Pill = ({ className = "", children }) => <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
const FromBase = () => <Pill className="bg-secondary-bg text-secondary-text">From the base</Pill>;

/** A control carried to a control plan characteristic, and where it stands against the plan now. */
const ControlLinkLine = ({ link, onEnd }) => (
  <li className="rounded-lg border border-border-color bg-secondary-bg px-3 py-2 text-sm">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-primary-text">
          <Pill className="mr-2 bg-brand-primary/15 text-brand-primary">{controlKindLabel(link.kind)}</Pill>
          {planTargetWords(link)}
          {link.carried && <span className="ml-2 text-xs text-secondary-text">carried on from the revision before</span>}
        </p>
        {link.note && <p className="text-xs text-secondary-text">{link.note}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill className={linkStatePill(link.state)}>{linkStateLabel(link.state)}</Pill>
        {link.canEnd && (
          <CTAButton type="neutral" icon={XIcon} aria-label={`End the link to ${planTargetWords(link)}`} onClick={onEnd}>
            End link
          </CTAButton>
        )}
      </div>
    </div>
  </li>
);

/** One cause: its controls, the ratings and what the database worked out from them. */
const ActionLine = ({ action, cause, onComplete, onEdit, onCancel, onReopen, busy }) => (
  <li className="rounded-lg border border-border-color bg-secondary-bg px-3 py-2 text-sm">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-primary-text">
          <Pill className="mr-2 bg-brand-primary/15 text-brand-primary">{actionKindLabel(action.kind)}</Pill>
          {action.description}
          {action.carried && <span className="ml-2 text-xs text-secondary-text">carried on from the revision before</span>}
          {action.adopted && <span className="ml-2 text-xs text-secondary-text">taken into a revision</span>}
        </p>
        <p className="text-xs text-secondary-text">
          {action.owner.name}
          {action.status === "open" && <> · <span className={action.overdue ? "font-medium text-error-color" : ""}>{dueWords(action)}</span></>}
          {action.status === "done" && action.doneAt && <> · done {action.doneBy ? `by ${action.doneBy.name}` : ""}</>}
        </p>
        {action.status === "done" && (
          <p className="text-xs text-secondary-text">
            Found: <span className="text-primary-text">{action.evidenceNote}</span>
            {revisedWords(action, cause) && <> · Comes to <span className="text-primary-text">{revisedWords(action, cause)}</span></>}
          </p>
        )}
        {action.status === "cancelled" && <p className="text-xs text-secondary-text">Cancelled: {action.cancelReason}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill className={actionStatusPill(action.status)}>{actionStatusLabel(action.status)}</Pill>
        {action.canComplete && (
          <CTAButton type="success" icon={CheckIcon} onClick={onComplete}>
            Finish
          </CTAButton>
        )}
        {action.canReopen && (
          <CTAButton type="neutral" icon={RotateCcwIcon} loading={busy} onClick={onReopen}>
            Reopen
          </CTAButton>
        )}
        {action.canEdit && (
          <>
            <CTAButton type="secondary" icon={PencilIcon} aria-label={`Change the action: ${action.description}`} onClick={onEdit}>
              Change
            </CTAButton>
            <CTAButton type="neutral" icon={XIcon} aria-label={`Cancel the action: ${action.description}`} onClick={onCancel}>
              Cancel
            </CTAButton>
          </>
        )}
      </div>
    </div>
  </li>
);

const CauseRow = ({ cause, scale, severityUsed, menu, actions }) => (
  <li className="rounded-xl border border-border-color bg-primary-bg px-3 py-2 text-sm">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="font-medium text-primary-text">
          {cause.text} {cause.fromBase && <FromBase />}
        </p>
        <p className="text-secondary-text">
          Prevention: {cause.preventionControls ?? "—"} · Detection: {cause.detectionControls ?? "—"}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {cause.priority ? (
          <Pill className={priorityPill(cause.priority)}>
            {priorityLabel(cause.priority)} · RPN {cause.rpn}
          </Pill>
        ) : (
          <Pill className="bg-secondary-bg text-secondary-text">Not rated</Pill>
        )}
        {cause.needsAttention && (
          <Pill className="bg-error-color/15 text-error-color">
            <TriangleAlertIcon size={12} className="mr-1" />
            Needs attention
          </Pill>
        )}
        {menu}
      </div>
    </div>
    <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-xs text-secondary-text">
      <div>
        <dt className="inline">Severity used </dt>
        <dd className="inline text-primary-text">{ratingWords(scale?.severity, severityUsed ?? cause.severityUsed)}</dd>
      </div>
      <div>
        <dt className="inline">Occurrence </dt>
        <dd className="inline text-primary-text">{ratingWords(scale?.occurrence, cause.occurrence)}</dd>
      </div>
      <div>
        <dt className="inline">Detection </dt>
        <dd className="inline text-primary-text">{ratingWords(scale?.detection, cause.detection)}</dd>
      </div>
      {cause.noActionReason && (
        <div>
          <dt className="inline">Why nothing more is done </dt>
          <dd className="inline text-primary-text">{cause.noActionReason}</dd>
        </div>
      )}
    </dl>
    {actions}
  </li>
);

/**
 * The analysis of a revision (docs/fmea-plan.md FM3): the structure as a tree, and under each item its functions, failure modes, effects and causes. Everything is
 * changed through the server, which answers with the whole revision (scores included), so nothing here works a rating out.
 */
const AnalysisEditor = ({ revision }) => {
  const { net, model, base, canEdit, canAct, fmea } = revision;
  const mutation = useFmeaNodeMutation();
  const actionMutation = useFmeaActionMutation();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState(null);
  const close = () => setDialog(null);
  const scale = model?.scale;

  const removeNode = async (action, id, title, message) => {
    const ok = await confirm({ title, message, confirmText: "Remove", cancelText: "Cancel", type: "warning" });
    if (ok) mutation.mutate({ action, id });
  };

  const actionsFor = (items) => (canEdit ? <RowActionsMenu label="Actions" items={items} /> : null);

  const renderMode = (fn, m) => (
    <li key={m.id} className="rounded-xl border border-border-color bg-secondary-bg p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-primary-text">
            <span className="text-secondary-text">Failure mode </span>
            {m.text} {m.specialClass && <Pill className="bg-warning-color/15 text-warning-color">{specialClassLabel(m.specialClass)}</Pill>} {m.fromBase && <FromBase />}
          </p>
          <p className="text-xs text-secondary-text">Worst severity among its effects: {ratingWords(scale?.severity, worstSeverity(m.effects))}</p>
          {m.ncFailureMode && <p className="text-xs text-secondary-text">Tied to “{m.ncFailureMode.name}” in the non-conformance register</p>}
        </div>
        {actionsFor([
          { label: "Add an effect", icon: PlusIcon, onSelect: () => setDialog({ type: "effect", mode: m }) },
          { label: "Add a cause", icon: PlusIcon, onSelect: () => setDialog({ type: "cause", mode: m }) },
          { separator: true },
          { label: "Change", icon: PencilIcon, onSelect: () => setDialog({ type: "mode", fn, existing: m }) },
          { label: "Remove", icon: Trash2Icon, tone: "danger", onSelect: () => removeNode("removeFailureMode", m.id, "Remove this failure mode?", "Its effects and causes go with it.") },
        ])}
      </div>
      <div className="mt-2 grid gap-3 lg:grid-cols-2">
        <section aria-label={`Effects of ${m.text}`}>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-secondary-text">Effects</h4>
          {m.effects.length === 0 ? (
            <p className="text-sm text-secondary-text">None yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {m.effects.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-2 rounded-xl border border-border-color bg-primary-bg px-3 py-2 text-sm">
                  <div>
                    <p className="text-primary-text">
                      {e.text} {e.fromBase && <FromBase />}
                    </p>
                    <p className="text-xs text-secondary-text">
                      {effectLevelLabel(e.level)} · Severity {ratingWords(scale?.severity, e.severity)}
                    </p>
                  </div>
                  {actionsFor([
                    { label: "Change", icon: PencilIcon, onSelect: () => setDialog({ type: "effect", mode: m, existing: e }) },
                    { label: "Remove", icon: Trash2Icon, tone: "danger", onSelect: () => removeNode("removeEffect", e.id, "Remove this effect?", "The causes of this failure mode are scored again.") },
                  ])}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label={`Causes of ${m.text}`}>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-secondary-text">Causes</h4>
          {m.causes.length === 0 ? (
            <p className="text-sm text-secondary-text">None yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {m.causes.map((c) => (
                <CauseRow
                  key={c.id}
                  cause={c}
                  scale={scale}
                  severityUsed={c.severityUsed}
                  menu={actionsFor([
                    { label: "Change", icon: PencilIcon, onSelect: () => setDialog({ type: "cause", mode: m, existing: c }) },
                    { label: "Remove", icon: Trash2Icon, tone: "danger", onSelect: () => removeNode("removeCause", c.id, "Remove this cause?", "It is taken out of the analysis.") },
                  ])}
                  actions={
                    (c.actions.length > 0 || c.controlLinks.length > 0 || canAct) && (
                      <div className="mt-2 flex flex-col gap-2" role="group" aria-label={`Actions for ${c.text}`}>
                        {c.actions.length > 0 && (
                          <ul className="flex flex-col gap-2">
                            {c.actions.map((a) => (
                              <ActionLine
                                key={a.id}
                                action={a}
                                cause={c}
                                busy={actionMutation.isPending && actionMutation.variables?.id === a.id}
                                onComplete={() => setDialog({ type: "complete", action: a, cause: c })}
                                onEdit={() => setDialog({ type: "action", cause: c, existing: a })}
                                onCancel={() => setDialog({ type: "cancelAction", action: a })}
                                onReopen={() => actionMutation.mutate({ action: "reopen", id: a.id })}
                              />
                            ))}
                          </ul>
                        )}
                        {canAct && (
                          <div>
                            <CTAButton type="secondary" icon={PlusIcon} onClick={() => setDialog({ type: "action", cause: c })}>
                              Add an action
                            </CTAButton>
                          </div>
                        )}
                        {(c.controlLinks.length > 0 || (canAct && (c.preventionControls || c.detectionControls))) && (
                          <div className="flex flex-col gap-2" role="group" aria-label={`Control plan for ${c.text}`}>
                            {c.controlLinks.length > 0 && (
                              <ul className="flex flex-col gap-2">
                                {c.controlLinks.map((l) => (
                                  <ControlLinkLine key={l.id} link={l} onEnd={() => setDialog({ type: "endLink", link: l })} />
                                ))}
                              </ul>
                            )}
                            {canAct && (c.preventionControls || c.detectionControls) && (
                              <div>
                                <CTAButton type="secondary" icon={LinkIcon} onClick={() => setDialog({ type: "carry", cause: c })}>
                                  Carry to the control plan
                                </CTAButton>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  }
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </li>
  );

  const renderFunction = (item, f) => (
    <li key={f.id} className="rounded-xl border border-border-color bg-primary-bg p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-medium text-primary-text">
          <span className="text-secondary-text">Function </span>
          {f.text} {f.fromBase && <FromBase />}
          {f.requirement && <span className="block font-normal text-secondary-text">Requirement: {f.requirement}</span>}
        </p>
        {actionsFor([
          { label: "Add a failure mode", icon: PlusIcon, onSelect: () => setDialog({ type: "mode", fn: f }) },
          { separator: true },
          { label: "Change", icon: PencilIcon, onSelect: () => setDialog({ type: "function", item, existing: f }) },
          { label: "Remove", icon: Trash2Icon, tone: "danger", onSelect: () => removeNode("removeFunction", f.id, "Remove this function?", "Its failure modes, effects and causes go with it.") },
        ])}
      </div>
      {f.failureModes.length > 0 && <ul className="mt-2 flex flex-col gap-2">{f.failureModes.map((m) => renderMode(f, m))}</ul>}
    </li>
  );

  const renderItem = (item) => (
    <li key={item.id} className="flex flex-col gap-2">
      <div className="rounded-xl border border-border-color bg-secondary-bg p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm text-primary-text">
              <Pill className="mr-2 bg-brand-primary/15 text-brand-primary">{itemKindLabel(item.kind)}</Pill>
              <span className="font-semibold">{item.name}</span>
              {item.elementType && <span className="text-secondary-text"> · {elementTypeLabel(item.elementType)}</span>}
              {item.operationCode && <span className="text-secondary-text"> · {item.operationCode}</span>} {item.fromBase && <FromBase />}
            </p>
            {item.description && <p className="text-xs text-secondary-text">{item.description}</p>}
          </div>
          {actionsFor([
            ...(CHILD_KINDS[item.kind] ?? []).map((k) => ({ label: `Add a ${itemKindLabel(k).toLowerCase()}`, icon: PlusIcon, onSelect: () => setDialog({ type: "item", parent: item, kind: k }) })),
            { label: "Add a function", icon: PlusIcon, onSelect: () => setDialog({ type: "function", item }) },
            { separator: true },
            { label: "Change", icon: PencilIcon, onSelect: () => setDialog({ type: "item", kind: item.kind, existing: item }) },
            { label: "Remove", icon: Trash2Icon, tone: "danger", onSelect: () => removeNode("removeItem", item.id, `Remove this ${itemKindLabel(item.kind).toLowerCase()}?`, "Everything under it goes with it: the items, functions, failure modes, effects and causes.") },
          ])}
        </div>
        {item.functions.length > 0 && <ul className="mt-2 flex flex-col gap-2">{item.functions.map((f) => renderFunction(item, f))}</ul>}
      </div>
      {item.children.length > 0 && <ul className="ml-4 flex flex-col gap-2 border-l-2 border-border-color pl-3">{item.children.map(renderItem)}</ul>}
    </li>
  );

  const { counts } = net;
  const tops = topKinds(fmea.kind);
  return (
    <MenuCard
      title="The analysis"
      subtitle={fmea.kind === "design" ? "System, sub-systems and components, what each is meant to do, how it could fail, with what effect and from what cause." : "Process items, steps and work elements, what each is meant to do, how it could fail, with what effect and from what cause."}
      action={
        canEdit && (
          <div className="flex gap-2">
            {tops.map((k) => (
              <CTAButton key={k} type="secondary" icon={PlusIcon} onClick={() => setDialog({ type: "item", kind: k })}>
                Add a {itemKindLabel(k).toLowerCase()}
              </CTAButton>
            ))}
          </div>
        )
      }>
      <div className="flex flex-col gap-3">
        {base && (
          <Callout tone="info" title="Started from a base">
            {base.fmeaId ? (
              <>
                This analysis began as a copy of{" "}
                <Link to={revisionPath(base.fmeaId, base.revisionId)} className="underline">
                  {base.number} {base.letter ? `rev ${base.letter}` : ""}
                </Link>{" "}
                ({base.title}). The copy is its own: changes here do not reach the base, and the base's later changes do not reach this.{" "}
                <Link to={fmeaPath(base.fmeaId)} className="underline">
                  Open the base
                </Link>
                .
              </>
            ) : (
              "This analysis began as a copy of an FMEA you may not open. The copy is its own."
            )}
          </Callout>
        )}
        {model && (
          <p className="text-sm text-secondary-text">
            Rated with model version {model.version} ({modelWords(model)}).{" "}
            {!model.isLatest && (
              <>
                The organisation is now on version {model.latestVersion}.{" "}
                {canEdit && (
                  <CTAButton type="secondary" size="default" loading={mutation.isPending && mutation.variables?.action === "useLatestModel"} onClick={() => mutation.mutate({ action: "useLatestModel", id: revision.id })}>
                    Use version {model.latestVersion} and score again
                  </CTAButton>
                )}
              </>
            )}
          </p>
        )}
        <p className="text-sm text-secondary-text" aria-label="Analysis figures">
          {counts.items} {counts.items === 1 ? "item" : "items"} · {counts.failureModes} failure {counts.failureModes === 1 ? "mode" : "modes"} · {counts.causes} {counts.causes === 1 ? "cause" : "causes"} ·{" "}
          {counts.needAttention} {counts.needAttention === 1 ? "needs" : "need"} attention · {counts.unrated} not rated · {counts.openActions} open {counts.openActions === 1 ? "action" : "actions"}{counts.overdueActions > 0 ? ` (${counts.overdueActions} late)` : ""} · {counts.controlLinks} carried to the control plan
        </p>
        <FormError error={mutation.error ?? actionMutation.error} />
        {net.items.length === 0 ? (
          <p className="text-sm text-secondary-text">Nothing yet.{canEdit ? ` Start with a ${itemKindLabel(tops[0]).toLowerCase()}.` : ""}</p>
        ) : (
          <ul aria-label="Structure" className="flex flex-col gap-2">
            {net.items.map(renderItem)}
          </ul>
        )}
      </div>
      {dialog?.type === "item" && <ItemDialog revision={revision} parent={dialog.parent} kind={dialog.kind} existing={dialog.existing} onClose={close} />}
      {dialog?.type === "function" && <FunctionDialog item={dialog.item} existing={dialog.existing} onClose={close} />}
      {dialog?.type === "mode" && <FailureModeDialog fn={dialog.fn} existing={dialog.existing} onClose={close} />}
      {dialog?.type === "effect" && <EffectDialog mode={dialog.mode} existing={dialog.existing} scale={scale} onClose={close} />}
      {dialog?.type === "action" && <ActionDialog cause={dialog.cause} existing={dialog.existing} onClose={close} />}
      {dialog?.type === "complete" && <CompleteActionDialog action={dialog.action} cause={dialog.cause} scale={scale} onClose={close} />}
      {dialog?.type === "cancelAction" && <CancelActionDialog action={dialog.action} onClose={close} />}
      {dialog?.type === "carry" && <CarryDialog cause={dialog.cause} onClose={close} />}
      {dialog?.type === "endLink" && <EndLinkDialog link={dialog.link} onClose={close} />}
      {dialog?.type === "cause" && <CauseDialog mode={dialog.mode} existing={dialog.existing} scale={scale} onClose={close} />}
    </MenuCard>
  );
};

export default AnalysisEditor;
