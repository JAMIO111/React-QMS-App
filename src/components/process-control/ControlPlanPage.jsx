import { useEffect, useState } from "react";
import Switch from "@/components/ui/Switch";
import { Link, useParams } from "react-router-dom";
import { ArrowLeftIcon, PlusIcon, Trash2Icon } from "@/components/icons";
import Field from "../ui/Field";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import Accordion from "../Settings/Accordion";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import PeoplePicker from "../calibration/PeoplePicker";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions, useSites } from "../../hooks/useQmsApi";
import { useControlPlan, usePartFamilies, useProcessControlMutation } from "../../hooks/useProcessControl";
import { describeApiError } from "../../lib/api-client";
import { ActiveBadge, ErrorNotice, FormError, SelectField, TextAreaField } from "../master-data/shared";
import ControlPlanHistory from "./ControlPlanHistory";
import { PartPicker } from "../ncr/Pickers";
import RequirementPreview from "./RequirementPreview";
import { formatDate, formatDateTime } from "../../lib/processControl";
import { RevisionStatusPill } from "./shared";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";

const th = "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2 align-top";

/** "yyyy-MM-dd" (local day) ↔ ISO timestamp at the start of that day. */
const dayToIso = (day) => (day ? new Date(`${day}T00:00:00`).toISOString() : null);
const isoToDay = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const PlanDetails = ({ plan, canManage }) => {
  const mutation = useProcessControlMutation();
  const { showToast } = useToast();
  const toForm = (p) => ({ planCode: p.planCode, title: p.title, description: p.description ?? "", ownerId: p.owner?.id ?? null, active: p.active });
  const [form, setForm] = useState(toForm(plan));
  useEffect(() => setForm(toForm(plan)), [plan]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      {
        path: `/control-plans/${plan.id}`,
        method: "PATCH",
        body: { planCode: form.planCode.trim(), title: form.title.trim(), description: form.description.trim(), ownerId: form.ownerId, active: form.active },
      },
      { onSuccess: () => showToast({ type: "success", title: "Saved", message: "Plan details updated." }) }
    );
  };

  return (
    <MenuCard as="form" onSubmit={submit} title="Plan" subtitle="Identity of the plan. Its requirements live in revisions." aria-label="Plan details" bodyClassName="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Plan code" value={form.planCode} onChange={set("planCode")} disabled={!canManage} required maxLength={40} />
        <Field label="Title" value={form.title} onChange={set("title")} disabled={!canManage} required maxLength={200} />
        <Field label="Description" value={form.description} onChange={set("description")} disabled={!canManage} maxLength={2000} className="md:col-span-2" />
        <PeoplePicker label="Owner" value={form.ownerId} onChange={(v) => setForm((f) => ({ ...f, ownerId: v ?? null }))} current={plan.owner} disabled={!canManage} clearable />
        {canManage && (
          <Switch className="self-end pb-2 text-sm text-primary-text" checked={form.active} onChange={set("active")}>
            Active (inactive plans take no new revisions)
          </Switch>
        )}
      </div>
      <FormError error={mutation.error} />
      {canManage && (
        <CTAButton buttonType="submit" type="main" size="lg" className="self-start" disabled={mutation.isPending} loading={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save changes"}
        </CTAButton>
      )}
    </MenuCard>
  );
};

const AddScopeForm = ({ plan, onDone }) => {
  const mutation = useProcessControlMutation();
  const families = usePartFamilies();
  const sites = useSites();
  const firstFamily = plan.applicability.find((a) => a.partFamily)?.partFamily.id ?? null;
  const [form, setForm] = useState({ target: "family", partFamilyId: firstFamily, partId: null, part: null, siteId: null, operationCode: "" });
  const ready = form.target === "family" ? !!form.partFamilyId : !!form.partId;

  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      {
        path: `/control-plans/${plan.id}/applicability`,
        body: {
          ...(form.target === "family" ? { partFamilyId: form.partFamilyId } : { partId: form.partId }),
          siteId: form.siteId,
          operationCode: form.operationCode.trim() || null,
        },
      },
      { onSuccess: onDone }
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Applies to" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {[
          { value: "family", label: "A part family", hint: "Every part in the family." },
          { value: "part", label: "A single part", hint: "Overrides family plans for that part; works for parts without a family." },
        ].map((o) => (
          <label
            key={o.value}
            className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-2 text-sm ${form.target === o.value ? "border-brand-primary bg-brand-primary/10" : "border-border-color"}`}>
            <span className="flex items-center gap-2 font-medium text-primary-text">
              <input type="radio" name="target" checked={form.target === o.value} onChange={() => setForm((f) => ({ ...f, target: o.value }))} /> {o.label}
            </span>
            <span className="text-xs text-secondary-text">{o.hint}</span>
          </label>
        ))}
      </div>
      {form.target === "family" ? (
        <SelectField
          label="Part family"
          required
          placeholder="Choose a family"
          value={form.partFamilyId}
          onChange={(v) => setForm((f) => ({ ...f, partFamilyId: v }))}
          options={(families.data?.items ?? []).map((f) => ({ value: f.id, label: `${f.code} · ${f.name}` }))}
        />
      ) : (
        <PartPicker label="Part" required value={form.partId} current={form.part} onChange={(id, item) => setForm((f) => ({ ...f, partId: id ?? null, part: item ?? null }))} />
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SelectField
          label="Site"
          placeholder="All sites"
          value={form.siteId}
          onChange={(v) => setForm((f) => ({ ...f, siteId: v }))}
          options={(sites.data?.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
        />
        <Field label="Operation" value={form.operationCode} onChange={(e) => setForm((f) => ({ ...f, operationCode: e.target.value }))} maxLength={30} hint="e.g. OP-020 (optional)" />
      </div>
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <CTAButton buttonType="button" type="neutral" size="md" onClick={onDone}>
          Cancel
        </CTAButton>
        <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending || !ready} loading={mutation.isPending}>
          {mutation.isPending ? "Adding…" : "Add scope"}
        </CTAButton>
      </div>
    </form>
  );
};

const Scope = ({ plan, canManage }) => {
  const mutation = useProcessControlMutation();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const [adding, setAdding] = useState(false);

  const remove = async (a) => {
    const ok = await confirm({
      title: "Remove this scope entry?",
      message: `${[a.partFamily?.code, a.part?.partNumber].filter(Boolean).join(" · ")} will no longer be covered by this entry.`,
      confirmText: "Remove",
      cancelText: "Cancel",
      type: "warning",
    });
    if (!ok) return;
    mutation.mutate(
      { path: `/control-plan-applicability/${a.id}`, method: "DELETE" },
      { onError: (err) => showToast({ type: "error", title: "Not removed", message: describeApiError(err) }) }
    );
  };

  return (
    <MenuCard
      title="Scope"
      subtitle="Where the plan applies: part families and/or single parts, optionally for one site or operation. A plan for a single part overrides family plans for it."
      bodyClassName="overflow-x-auto"
      action={
        canManage && (
          <CTAButton buttonType="button" type="neutral" size="md" className="flex items-center gap-1" onClick={() => setAdding(true)}>
            <PlusIcon className="h-4 w-4" /> Add scope
          </CTAButton>
        )
      }>
      {plan.applicability.length === 0 ? (
        <p className="text-sm text-secondary-text">No scope yet: the plan does not apply to any part. Add a part family or a single part.</p>
      ) : (
        <table className="w-full min-w-[560px] border-separate border-spacing-0 text-sm text-primary-text" aria-label="Scope">
          <thead>
            <tr>
              <th scope="col" className={th}>Part family</th>
              <th scope="col" className={th}>Part</th>
              <th scope="col" className={th}>Site</th>
              <th scope="col" className={th}>Operation</th>
              {canManage && <th scope="col" className={th}><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {plan.applicability.map((a) => (
              <tr key={a.id}>
                <td className={td}>
                  {a.partFamily ? (
                    <>
                      <Link to={`/Part-Families/${a.partFamily.id}`} className="text-link-color hover:underline">
                        {a.partFamily.code}
                      </Link>{" "}
                      <span className="text-secondary-text">· {a.partFamily.name}</span>
                    </>
                  ) : (
                    <span className="text-secondary-text">Single part</span>
                  )}
                </td>
                <td className={td}>
                  {a.part ? (
                    <>
                      <Link to={`/Parts/${a.part.id}`} className="text-link-color hover:underline">
                        {a.part.partNumber}
                      </Link>
                      <span className="ml-2 text-xs text-secondary-text">overrides family plans</span>
                    </>
                  ) : (
                    "All parts"
                  )}
                </td>
                <td className={td}>{a.site?.name ?? "All sites"}</td>
                <td className={`${td} font-mono`}>{a.operationCode ?? <span className="font-sans">All</span>}</td>
                {canManage && (
                  <td className={td}>
                    <div className="flex justify-end">
                      <CTAButton buttonType="button" type="danger" size="md" disabled={mutation.isPending} loading={mutation.isPending} onClick={() => remove(a)} aria-label="Remove scope entry">
                        <Trash2Icon className="h-4 w-4" />
                      </CTAButton>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adding && (
        <Dialog title="Add scope" onClose={() => setAdding(false)}>
          <AddScopeForm plan={plan} onDone={() => setAdding(false)} />
        </Dialog>
      )}
    </MenuCard>
  );
};

const RevisionForm = ({ plan, revision, onDone }) => {
  const mutation = useProcessControlMutation();
  const { showToast } = useToast();
  const latest = plan.revisions[0]?.revisionCode;
  const [form, setForm] = useState({
    revisionCode: revision?.revisionCode ?? "",
    changeReason: revision?.changeReason ?? "",
    effectiveFrom: isoToDay(revision?.effectiveFrom),
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    const body = { revisionCode: form.revisionCode.trim(), changeReason: form.changeReason.trim(), effectiveFrom: dayToIso(form.effectiveFrom) };
    mutation.mutate(
      revision ? { path: `/control-plan-revisions/${revision.id}`, method: "PATCH", body } : { path: `/control-plans/${plan.id}/revisions`, body },
      {
        onSuccess: (saved) => {
          showToast({ type: "success", title: "Saved", message: revision ? `Draft ${saved.revisionCode} updated.` : `Draft revision ${saved.revisionCode} created.` });
          onDone();
        },
      }
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Revision" value={form.revisionCode} onChange={set("revisionCode")} required maxLength={10} hint={latest && !revision ? `Latest is ${latest}` : "e.g. B, 02"} />
        <RHFDatePickerPopout
          label="Effective from"
          value={form.effectiveFrom}
          onChange={(v) => setForm((f) => ({ ...f, effectiveFrom: v || null }))}
          valueFormat="iso"
          clearable
          hint="Leave empty to make it effective on approval"
        />
      </div>
      <TextAreaField label="Reason for change" required value={form.changeReason} onChange={set("changeReason")} maxLength={2000} hint="Required before submitting for approval" />
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <CTAButton buttonType="button" type="neutral" size="md" onClick={onDone}>
          Cancel
        </CTAButton>
        <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending} loading={mutation.isPending}>
          {mutation.isPending ? "Saving…" : revision ? "Save draft" : "Create draft"}
        </CTAButton>
      </div>
    </form>
  );
};

/** What each lifecycle action asks for and says. */
const ACTIONS = {
  submit: { label: "Submit for approval", title: "Submit revision {rev} for approval?", text: "It is locked while it is reviewed.", style: "primary" },
  withdraw: { label: "Withdraw", title: "Withdraw revision {rev}?", text: "It goes back to draft so it can be edited.", style: "neutral" },
  send_back: { label: "Send back", title: "Send revision {rev} back to draft?", text: "Say what needs changing.", style: "neutral", field: "comment", required: true },
  approve: { label: "Approve", title: "Approve revision {rev}?", text: "", style: "primary", field: "comment" },
  make_effective: { label: "Make effective", title: "Make revision {rev} effective now?", text: "New inspections will use it.", style: "primary" },
  obsolete: { label: "Make obsolete", title: "Make revision {rev} obsolete?", text: "It is kept as history and can no longer be used.", style: "danger", field: "reason", required: true },
};

const ActionDialog = ({ plan, revision, action, onDone }) => {
  const mutation = useProcessControlMutation();
  const { showToast } = useToast();
  const [text, setText] = useState("");
  const a = ACTIONS[action];
  const effective = plan.revisions.find((r) => r.status === "effective");
  const future = revision.effectiveFrom && new Date(revision.effectiveFrom) > new Date();
  let note = a.text;
  if (action === "approve") {
    note = future
      ? `It becomes effective on ${formatDate(revision.effectiveFrom)}; make it effective then.`
      : `It becomes effective straight away${effective ? ` and revision ${effective.revisionCode} is superseded` : ""}.`;
  }
  if (action === "make_effective" && effective) note = `New inspections will use it; revision ${effective.revisionCode} is superseded.`;

  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      { path: `/control-plan-revisions/${revision.id}/transitions`, body: { action, ...(a.field ? { [a.field]: text.trim() } : {}) } },
      {
        onSuccess: (saved) => {
          showToast({ type: "success", title: "Saved", message: `Revision ${saved.revisionCode} is now ${saved.status.replace("_", " ")}.` });
          onDone();
        },
      }
    );
  };

  return (
    <Dialog title={a.title.replace("{rev}", revision.revisionCode)} onClose={onDone}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        {note && <p className="text-sm text-primary-text">{note}</p>}
        {a.field && (
          <TextAreaField
            label={a.field === "reason" ? "Reason" : "Comment"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            required={a.required}
            maxLength={2000}
          />
        )}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onDone}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type={a.style} size="md" disabled={mutation.isPending || (a.required && !text.trim())} loading={mutation.isPending}>
            {mutation.isPending ? "Saving…" : a.label}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Actions offered for a revision, given its status and the user's permissions. */
const actionsFor = (r, { canManage, canApprove }) => {
  const now = new Date();
  switch (r.status) {
    case "draft":
      return [...(canManage ? ["edit", "submit", "obsolete"] : [])];
    case "pending_approval":
      return [...(canApprove ? ["approve", "send_back"] : []), ...(canManage ? ["withdraw"] : [])];
    case "approved":
      return canApprove ? [...(!r.effectiveFrom || new Date(r.effectiveFrom) <= now ? ["make_effective"] : []), "obsolete"] : [];
    case "effective":
      return canApprove ? ["obsolete"] : [];
    default:
      return [];
  }
};

const Revisions = ({ plan, canManage, canApprove }) => {
  const [editing, setEditing] = useState(null); // null | "new" | revision
  const [acting, setActing] = useState(null); // { revision, action }
  const hasOpen = plan.revisions.some((r) => r.status === "draft" || r.status === "pending_approval");

  return (
    <MenuCard
      title="Revisions"
      subtitle="Draft → awaiting approval → approved → effective. A new revision starts from the current one; approved revisions are never edited."
      bodyClassName="overflow-x-auto"
      action={
        canManage &&
        !hasOpen &&
        plan.active && (
          <CTAButton buttonType="button" type="neutral" size="md" className="flex items-center gap-1" onClick={() => setEditing("new")}>
            <PlusIcon className="h-4 w-4" /> New revision
          </CTAButton>
        )
      }>
      {plan.revisions.length === 0 ? (
        <p className="text-sm text-secondary-text">No revisions yet.</p>
      ) : (
        <table className="w-full min-w-[820px] border-separate border-spacing-0 text-sm text-primary-text" aria-label="Revisions">
          <thead>
            <tr>
              <th scope="col" className={th}>Revision</th>
              <th scope="col" className={th}>Status</th>
              <th scope="col" className={th}>Reason for change</th>
              <th scope="col" className={th}>Effective</th>
              <th scope="col" className={th}>Review</th>
              <th scope="col" className={th}><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {plan.revisions.map((r) => {
              const actions = actionsFor(r, { canManage, canApprove });
              return (
                <tr key={r.id}>
                  <td className={`${td} font-mono`}>
                    <Link to={`/Process-Control/Plans/${plan.id}/revisions/${r.id}`} className="text-link-color hover:underline" aria-label={`Open revision ${r.revisionCode}`}>
                      {r.revisionCode}
                    </Link>
                    {r.supersedesRevision && <div className="font-sans text-xs text-secondary-text">replaces {r.supersedesRevision.revisionCode}</div>}
                  </td>
                  <td className={td}>
                    <RevisionStatusPill status={r.status} />
                  </td>
                  <td className={td}>
                    {r.changeReason ?? <span className="text-secondary-text">—</span>}
                    {r.status === "obsolete" && r.obsoleteReason && <div className="text-xs text-secondary-text">Obsolete: {r.obsoleteReason}</div>}
                  </td>
                  <td className={`${td} whitespace-nowrap`}>
                    {r.effectiveFrom ? formatDateTime(r.effectiveFrom) : <span className="text-secondary-text">On approval</span>}
                    {r.effectiveUntil && <div className="text-xs text-secondary-text">until {formatDateTime(r.effectiveUntil)}</div>}
                  </td>
                  <td className={`${td} text-xs text-secondary-text`}>
                    {r.submittedAt && (
                      <div>
                        Submitted by {r.submittedBy?.name ?? "—"} · {formatDate(r.submittedAt)}
                      </div>
                    )}
                    {r.approvedAt && (
                      <div>
                        Approved by {r.approvedBy?.name ?? "—"} · {formatDate(r.approvedAt)}
                      </div>
                    )}
                    {r.reviewComment && <div className="text-primary-text">“{r.reviewComment}”</div>}
                    {!r.submittedAt && !r.approvedAt && !r.reviewComment && `Created by ${r.createdBy?.name ?? "—"}`}
                  </td>
                  <td className={td}>
                    <div className="flex flex-wrap justify-end gap-2">
                      {actions.map((a) =>
                        a === "edit" ? (
                          <span key={a} className="flex gap-2">
                            <CTAButton to={`/Process-Control/Plans/${plan.id}/revisions/${r.id}`} type="main" size="lg">
                              Edit checks
                            </CTAButton>
                            <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setEditing(r)} aria-label={`Edit revision ${r.revisionCode}`}>
                              Details
                            </CTAButton>
                          </span>
                        ) : (
                          <CTAButton key={a} type={ACTIONS[a].style} size="md" onClick={() => setActing({ revision: r, action: a })}>
                            {a === "obsolete" && r.status === "draft" ? "Discard" : ACTIONS[a].label}
                          </CTAButton>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {editing && (
        <Dialog title={editing === "new" ? "New revision" : `Edit draft ${editing.revisionCode}`} onClose={() => setEditing(null)}>
          <RevisionForm plan={plan} revision={editing === "new" ? null : editing} onDone={() => setEditing(null)} />
        </Dialog>
      )}
      {acting && <ActionDialog plan={plan} revision={acting.revision} action={acting.action} onDone={() => setActing(null)} />}
    </MenuCard>
  );
};

/** One control plan: identity, scope, revisions and their lifecycle, history. */
const ControlPlanPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const canManage = can("process_control.manage");
  const canApprove = can("process_control.approve");
  const { data: plan, isLoading, error } = useControlPlan(id);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <Link to="/Process-Control/Plans" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
        <ArrowLeftIcon className="h-4 w-4" /> Control plans
      </Link>
      {isLoading && <LoadingScreen />}
      {error && <ErrorNotice error={error} />}
      {plan && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-primary-text">
              {plan.planCode} <span className="font-normal text-secondary-text">· {plan.title}</span>
            </h1>
            <ActiveBadge active={plan.active} />
            <span className="text-sm text-secondary-text">
              Effective revision: <strong className="font-mono text-primary-text">{plan.effectiveRevision ?? "none"}</strong>
            </span>
          </div>
          <PlanDetails plan={plan} canManage={canManage} />
          <Scope plan={plan} canManage={canManage} />
          <Revisions plan={plan} canManage={canManage} canApprove={canApprove} />
          <RequirementPreview parts={plan.scopeParts} showPlanLink={false} />
          <Accordion title="History" subtitle="Every change to the plan, its scope and its revisions.">
            <ControlPlanHistory id={plan.id} />
          </Accordion>
        </>
      )}
    </div>
  );
};

export default ControlPlanPage;
