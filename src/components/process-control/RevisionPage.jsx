import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeftIcon, PencilIcon, PlusIcon, Trash2Icon } from "@/components/icons";
import Field from "../ui/Field";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useMsaCoverage } from "../../hooks/useMsa";
import { worstCoverage } from "../../lib/msa";
import { CoveragePill } from "../msa/CoverageView";
import { usePlanFmeaCover } from "../../hooks/useFmea";
import { fmeaPath, priorityLabel, priorityPill } from "../../lib/fmea";
import { useControlPlanRevision, useMachines, useProcessControlMutation, useRevisionComparison } from "../../hooks/useProcessControl";
import { describeApiError } from "../../lib/api-client";
import { CRITICALITY, REACTION_ACTIONS, REACTION_TRIGGERS, describeRequirement, describeSampling, describeSpc } from "../../lib/processControl";
import { ErrorNotice, FormError, SelectField } from "../master-data/shared";
import CharacteristicForm from "./CharacteristicForm";
import { RevisionStatusPill } from "./shared";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";
import { useQuickSave } from "../../hooks/useQuickSave";
import { addToList, changeRecord } from "../../lib/guessRequest";
import { isPending, pendingId } from "../../lib/optimistic";
import LinkedChanges from "../change/LinkedChanges";
import { PpapPrompts } from "../ppap/PartPpap";

const th = "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2 align-top";

const OperationForm = ({ revision, operation, onDone }) => {
  const quickSave = useQuickSave(useProcessControlMutation());
  const machines = useMachines();
  const nextSequence = (Math.max(0, ...revision.operations.map((o) => o.sequence)) || 0) + 10;
  const [form, setForm] = useState({
    operationCode: operation?.operationCode ?? "",
    sequence: String(operation?.sequence ?? nextSequence),
    name: operation?.name ?? "",
    machineId: operation?.machine?.id ?? null,
    workCentre: operation?.workCentre ?? "",
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    const body = {
      operationCode: form.operationCode.trim(),
      sequence: Number(form.sequence) || 0,
      name: form.name.trim(),
      machineId: form.machineId,
      workCentre: form.workCentre.trim(),
    };
    // Shown at once (a new one without actions until the server has made it); put back with a toast if the server refuses.
    const m = (machines.data?.items ?? []).find((x) => x.id === body.machineId);
    const machine = m ? { id: m.id, code: m.code, name: m.name } : null;
    const shown = { ...body, workCentre: body.workCentre || null, machine };
    quickSave(
      operation
        ? { path: `/control-plan-operations/${operation.id}`, method: "PATCH", body, guess: changeRecord(operation.id, (o) => ({ ...o, ...shown })) }
        : { path: `/control-plan-revisions/${revision.id}/operations`, body, guess: addToList(revision.id, "operations", { id: pendingId(), ...shown, characteristics: [] }) },
      operation ? "Not saved" : "Not added",
    );
    onDone();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_8rem]">
        <Field label="Operation" value={form.operationCode} onChange={set("operationCode")} required maxLength={30} hint="e.g. OP-020" />
        <Field label="Sequence" inputMode="numeric" value={form.sequence} onChange={set("sequence")} required />
      </div>
      <Field label="Name" value={form.name} onChange={set("name")} required maxLength={200} hint="e.g. CNC turning" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SelectField
          label="Machine"
          placeholder="Any machine"
          value={form.machineId}
          onChange={(v) => setForm((f) => ({ ...f, machineId: v }))}
          options={(machines.data?.items ?? []).map((m) => ({ value: m.id, label: `${m.code} · ${m.name}` }))}
        />
        <Field label="Work centre" value={form.workCentre} onChange={set("workCentre")} maxLength={100} />
      </div>
      <div className="flex justify-end gap-2">
        <CTAButton buttonType="button" type="neutral" size="md" onClick={onDone}>
          Cancel
        </CTAButton>
        <CTAButton buttonType="submit" type="main" size="lg">
          {operation ? "Save operation" : "Add operation"}
        </CTAButton>
      </div>
    </form>
  );
};

const RevisionReactionsForm = ({ revision, onDone }) => {
  const quickSave = useQuickSave(useProcessControlMutation());
  const [rows, setRows] = useState(revision.reactions.map(({ triggerType, action, instruction }) => ({ triggerType, action, instruction })));
  const update = (i, patch) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  const submit = (e) => {
    e.preventDefault();
    const reactions = rows.filter((r) => r.instruction.trim());
    // The list shows at once; put back with a toast if the server refuses.
    quickSave({
      path: `/control-plan-revisions/${revision.id}/reactions`,
      method: "PUT",
      body: { reactions },
      guess: changeRecord(revision.id, (r) => ({ ...r, reactions: reactions.map((x, i) => ({ id: pendingId(), ...x, sequence: i + 1 })) })),
    });
    onDone();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[12rem_10rem_1fr_auto]">
          <SelectField
            label="When"
            required
            value={r.triggerType}
            onChange={(v) => update(i, { triggerType: v })}
            options={Object.entries(REACTION_TRIGGERS).map(([value, label]) => ({ value, label }))}
          />
          <SelectField
            label="Action"
            required
            value={r.action}
            onChange={(v) => update(i, { action: v })}
            options={Object.entries(REACTION_ACTIONS).map(([value, label]) => ({ value, label }))}
          />
          <Field label="Instruction" value={r.instruction} required maxLength={2000} onChange={(e) => update(i, { instruction: e.target.value })} />
          <CTAButton buttonType="button" type="danger" size="md" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove reaction ${i + 1}`}>
            <Trash2Icon className="h-4 w-4" />
          </CTAButton>
        </div>
      ))}
      <CTAButton
        buttonType="button"
        type="neutral" size="md" className="flex w-fit items-center gap-1"
        onClick={() => setRows((rs) => [...rs, { triggerType: "gauge_invalid", action: "stop", instruction: "" }])}>
        <PlusIcon className="h-4 w-4" /> Add reaction
      </CTAButton>
      <div className="flex justify-end gap-2">
        <CTAButton buttonType="button" type="neutral" size="md" onClick={onDone}>
          Cancel
        </CTAButton>
        <CTAButton buttonType="submit" type="main" size="lg">
          Save reactions
        </CTAButton>
      </div>
    </form>
  );
};

const Criticality = ({ value }) => {
  const c = CRITICALITY[value] ?? CRITICALITY.minor;
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${c.className}`}>{c.label}</span>;
};

const Operation = ({ operation, editable, onEdit, onAddCharacteristic, onEditCharacteristic, coverage, fmeaCover }) => {
  const mutation = useProcessControlMutation();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const failed = (title) => (err) => showToast({ type: "error", title, message: describeApiError(err) });

  const removeOperation = async () => {
    if (!(await confirm({ title: `Remove ${operation.operationCode}?`, message: "It is removed from this draft only.", confirmText: "Remove", cancelText: "Cancel", type: "warning" }))) return;
    mutation.mutate({ path: `/control-plan-operations/${operation.id}`, method: "DELETE" }, { onError: failed("Not removed") });
  };
  const removeCharacteristic = async (ch) => {
    if (!(await confirm({ title: `Remove ${ch.name}?`, message: `${ch.characteristicKey} and its sampling and reactions are removed from this draft. The comparison will show it as removed.`, confirmText: "Remove", cancelText: "Cancel", type: "warning" }))) return;
    mutation.mutate({ path: `/control-plan-characteristics/${ch.id}`, method: "DELETE" }, { onError: failed("Not removed") });
  };

  return (
    <MenuCard
      title={`${operation.operationCode} · ${operation.name}`}
      subtitle={[operation.machine && `${operation.machine.code} · ${operation.machine.name}`, operation.workCentre].filter(Boolean).join(" · ") || "Any machine"}
      bodyClassName="overflow-x-auto"
      action={
        editable && (
          <div className="flex gap-2">
            <CTAButton buttonType="button" type="neutral" size="md" className="flex items-center gap-1" onClick={() => onAddCharacteristic(operation)}>
              <PlusIcon className="h-4 w-4" /> Characteristic
            </CTAButton>
            <CTAButton buttonType="button" type="neutral" size="md" onClick={() => onEdit(operation)} aria-label={`Edit ${operation.operationCode}`}>
              <PencilIcon className="h-4 w-4" />
            </CTAButton>
            <CTAButton buttonType="button" type="danger" size="md" onClick={removeOperation} aria-label={`Remove ${operation.operationCode}`}>
              <Trash2Icon className="h-4 w-4" />
            </CTAButton>
          </div>
        )
      }>
      {operation.characteristics.length === 0 ? (
        <p className="text-sm text-secondary-text">No characteristics at this operation yet.</p>
      ) : (
        <table className="w-full min-w-[960px] border-separate border-spacing-0 text-sm text-primary-text" aria-label={`Characteristics at ${operation.operationCode}`}>
          <thead>
            <tr>
              <th scope="col" className={th}>Characteristic</th>
              <th scope="col" className={th}>Requirement</th>
              <th scope="col" className={th}>Applies to</th>
              <th scope="col" className={th}>Method / gauge</th>
              <th scope="col" className={th}>Sampling</th>
              <th scope="col" className={th}>SPC</th>
              <th scope="col" className={th}>Criticality</th>
              {editable && <th scope="col" className={th}><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {operation.characteristics.map((ch) => (
              <tr key={ch.id}>
                <td className={td}>
                  <div className="font-medium">
                    {ch.charNumber && <span className="mr-1 text-secondary-text">#{ch.charNumber}</span>}
                    {ch.name}
                  </div>
                  <div className="font-mono text-xs text-secondary-text">{ch.characteristicKey}</div>
                  {coverage?.get(`${operation.operationCode}:${ch.characteristicKey.toUpperCase()}`) && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-secondary-text">
                      Gauge R&amp;R <CoveragePill state={coverage.get(`${operation.operationCode}:${ch.characteristicKey.toUpperCase()}`)} />
                    </div>
                  )}
                  {fmeaCover?.get(`${operation.operationCode.toUpperCase()}:${ch.characteristicKey.toUpperCase()}`)?.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-0.5 text-xs text-secondary-text" aria-label={`FMEA causes covered by ${ch.characteristicKey}`}>
                      {fmeaCover.get(`${operation.operationCode.toUpperCase()}:${ch.characteristicKey.toUpperCase()}`).map((c) => (
                        <li key={`${c.causeId}-${c.kind}`} className="flex flex-wrap items-center gap-1">
                          FMEA{" "}
                          <Link className="text-brand-primary hover:underline" to={fmeaPath(c.fmeaId)}>
                            {c.fmeaNumber}
                          </Link>
                          : {c.cause}
                          {c.priority && <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ${priorityPill(c.priority)}`}>{priorityLabel(c.priority)}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className={`${td} tabular-nums`}>{describeRequirement(ch)}</td>
                <td className={td}>{ch.appliesTo === "selected" ? ch.parts.map((p) => p.partNumber).join(", ") || <span className="text-error-color">No parts chosen</span> : "All parts"}</td>
                <td className={td}>
                  {ch.method ?? "—"}
                  {ch.gaugeType && <div className="text-xs text-secondary-text">{ch.gaugeType.name}</div>}
                </td>
                <td className={td}>
                  {ch.sampling.length ? ch.sampling.map((s) => <div key={s.id}>{describeSampling(s)}</div>) : <span className="text-secondary-text">On demand</span>}
                  {ch.reactions.length > 0 && <div className="text-xs text-secondary-text">{ch.reactions.length} reaction{ch.reactions.length > 1 ? "s" : ""}</div>}
                </td>
                <td className={td}>{describeSpc(ch) ?? <span className="text-secondary-text">—</span>}</td>
                <td className={td}>
                  <Criticality value={ch.criticality} />
                </td>
                {editable && (
                  <td className={td}>
                    <div className="flex justify-end gap-2">
                      <CTAButton buttonType="button" type="neutral" size="md" onClick={() => onEditCharacteristic(ch)} aria-label={`Edit ${ch.characteristicKey}`}>
                        <PencilIcon className="h-4 w-4" />
                      </CTAButton>
                      <CTAButton buttonType="button" type="danger" size="md" onClick={() => removeCharacteristic(ch)} aria-label={`Remove ${ch.characteristicKey}`}>
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
    </MenuCard>
  );
};

const CHANGE_STYLE = {
  added: "bg-success-color/15 text-success-color",
  removed: "bg-error-color/15 text-error-color",
  changed: "bg-warning-color/15 text-primary-text",
};
const TOLERANCE = { tightened: "Tolerance tightened", loosened: "Tolerance loosened", shifted: "Tolerance shifted" };

/** Before/after comparison with the revision this one replaces (PCB §4 "Revision comparison"). */
const Comparison = ({ revision }) => {
  const { data, isLoading, error } = useRevisionComparison(revision.id, !!revision.supersedesRevision);
  if (!revision.supersedesRevision) return null;
  const nothing = data && !data.characteristics.length && !data.operations.length && !data.reactions.length;
  return (
    <MenuCard
      title={`Changes from revision ${revision.supersedesRevision.revisionCode}`}
      subtitle="Review removed characteristics and tolerance changes before approval."
      bodyClassName="flex flex-col gap-3">
      {isLoading && <p className="text-sm text-secondary-text">Comparing…</p>}
      {error && <FormError error={error} />}
      {nothing && <p className="text-sm text-secondary-text">No changes yet.</p>}
      {data && !nothing && (
        <>
          <p className="text-sm text-primary-text">
            {data.summary.added} added · {data.summary.changed} changed · {data.summary.removed} removed
          </p>
          <ul className="flex flex-col gap-2" aria-label="Changes">
            {data.operations.map((o) => (
              <li key={`op-${o.operationCode}`} className="rounded-lg border border-border-color p-2 text-sm">
                <span className={`mr-2 rounded-full px-2 py-0.5 text-xs capitalize ${CHANGE_STYLE[o.change]}`}>{o.change}</span>
                Operation <strong>{o.operationCode}</strong>
                {o.fields.map((f) => (
                  <div key={f.field} className="ml-2 text-secondary-text">
                    {f.label}: <span className="line-through">{f.from ?? "—"}</span> → <span className="text-primary-text">{f.to ?? "—"}</span>
                  </div>
                ))}
              </li>
            ))}
            {data.characteristics.map((c) => (
              <li key={c.characteristicKey} className="rounded-lg border border-border-color p-2 text-sm">
                <span className={`mr-2 rounded-full px-2 py-0.5 text-xs capitalize ${CHANGE_STYLE[c.change]}`}>{c.change}</span>
                <strong>{c.name}</strong> <span className="font-mono text-xs text-secondary-text">{c.characteristicKey}</span>
                {c.tolerance && <span className="ml-2 text-xs font-medium text-primary-text">{TOLERANCE[c.tolerance]}</span>}
                {c.fields.map((f) => (
                  <div key={f.field} className="ml-2 text-secondary-text">
                    {f.label}: <span className="line-through">{f.from ?? "—"}</span> → <span className="text-primary-text">{f.to ?? "—"}</span>
                  </div>
                ))}
              </li>
            ))}
            {data.reactions.map((r) => (
              <li key={`${r.change}-${r.description}`} className="rounded-lg border border-border-color p-2 text-sm">
                <span className={`mr-2 rounded-full px-2 py-0.5 text-xs capitalize ${CHANGE_STYLE[r.change]}`}>{r.change}</span>
                General reaction: {r.description}
              </li>
            ))}
          </ul>
        </>
      )}
    </MenuCard>
  );
};

/** One revision of a control plan: its operations and characteristics, editable while a draft. */
const RevisionPage = () => {
  const { planId, revisionId } = useParams();
  const { can } = usePermissions();
  const { data: revision, isLoading, error } = useControlPlanRevision(revisionId);
  const editable = can("process_control.manage") && revision?.status === "draft";
  const [editingOperation, setEditingOperation] = useState(null); // null | "new" | operation
  const [editingCharacteristic, setEditingCharacteristic] = useState(null); // null | { characteristic?, operationId? }
  const [editingReactions, setEditingReactions] = useState(false);
  // Gauge R&R badge on each critical or major characteristic of the revision in force: the worst state among the gauges it was measured with.
  const showCoverage = can("calibration.read") && revision?.status === "effective";
  const coverageQuery = useMsaCoverage({ controlPlanId: planId, state: "all" }, { enabled: !!showCoverage });
  const coverage = useMemo(() => {
    const rows = coverageQuery.data?.available ? coverageQuery.data.rows : [];
    const by = new Map();
    rows.forEach((r) => {
      const k = `${r.characteristic.operationCode}:${r.characteristic.key.toUpperCase()}`;
      by.set(k, [...(by.get(k) ?? []), r.state]);
    });
    return new Map([...by].map(([k, states]) => [k, worstCoverage(states)]));
  }, [coverageQuery.data]);
  // The FMEA causes (of FMEAs in force) that carry a control to a characteristic of this revision: information beside the characteristic.
  const fmeaQuery = usePlanFmeaCover(revisionId, { enabled: can("fmea.read") });
  const fmeaCover = useMemo(() => {
    const by = new Map();
    (fmeaQuery.data?.available ? fmeaQuery.data.data : []).forEach((g) => by.set(`${g.operationCode.toUpperCase()}:${g.characteristicKey.toUpperCase()}`, g.covers));
    return by;
  }, [fmeaQuery.data]);
  const count = revision?.operations.reduce((n, o) => n + o.characteristics.length, 0) ?? 0;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <Link to={`/Process-Control/Plans/${planId}`} className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
        <ArrowLeftIcon className="h-4 w-4" /> {revision ? revision.plan.planCode : "Control plan"}
      </Link>
      {isLoading && <LoadingScreen />}
      {error && <ErrorNotice error={error} />}
      {revision && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-primary-text">
              {revision.plan.planCode} <span className="font-normal text-secondary-text">· revision</span> <span className="font-mono">{revision.revisionCode}</span>
            </h1>
            <RevisionStatusPill status={revision.status} />
            <span className="text-sm text-secondary-text">
              {revision.operations.length} operation{revision.operations.length === 1 ? "" : "s"} · {count} characteristic{count === 1 ? "" : "s"}
            </span>
          </div>
          {!editable && (
            <p className="text-sm text-secondary-text">
              {revision.status === "draft"
                ? "You can view this draft; editing needs the process control manage permission."
                : "This revision is locked. To change the plan, create a new revision from the plan page."}
            </p>
          )}
          {editable && revision.operations.length === 0 && (
            <p className="text-sm text-primary-text">Start with an operation (e.g. OP-020 CNC turning), then add the characteristics checked there.</p>
          )}
          {revision.operations.map((o) => (
            <Operation
              key={o.id}
              operation={o}
              editable={editable && !isPending(o.id)}
              onEdit={setEditingOperation}
              onAddCharacteristic={(op) => setEditingCharacteristic({ operationId: op.id })}
              onEditCharacteristic={(ch) => setEditingCharacteristic({ characteristic: ch })}
              coverage={showCoverage ? coverage : undefined}
              fmeaCover={fmeaCover}
            />
          ))}
          {editable && (
            <CTAButton buttonType="button" type="neutral" size="md" className="flex w-fit items-center gap-1" onClick={() => setEditingOperation("new")}>
              <PlusIcon className="h-4 w-4" /> Add operation
            </CTAButton>
          )}

          <MenuCard
            title="General reactions"
            subtitle="Apply to every characteristic of this revision, in addition to its own reactions."
            action={
              editable && (
                <CTAButton buttonType="button" type="neutral" size="md" className="flex items-center gap-1" onClick={() => setEditingReactions(true)}>
                  <PencilIcon className="h-4 w-4" /> Edit
                </CTAButton>
              )
            }>
            {revision.reactions.length === 0 ? (
              <p className="text-sm text-secondary-text">None.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm text-primary-text">
                {revision.reactions.map((r) => (
                  <li key={r.id}>
                    <strong>{REACTION_TRIGGERS[r.triggerType]}</strong> → {REACTION_ACTIONS[r.action]}: {r.instruction}
                  </li>
                ))}
              </ul>
            )}
          </MenuCard>

          <Comparison revision={revision} />
          <LinkedChanges kind="control_plan_revision" id={revision.id} />
          <PpapPrompts kind="control_plan_revision" id={revision.id} />

          {editingOperation && (
            <Dialog title={editingOperation === "new" ? "Add operation" : `Edit ${editingOperation.operationCode}`} onClose={() => setEditingOperation(null)}>
              <OperationForm revision={revision} operation={editingOperation === "new" ? null : editingOperation} onDone={() => setEditingOperation(null)} />
            </Dialog>
          )}
          {editingCharacteristic && (
            <Dialog
              title={editingCharacteristic.characteristic ? `Edit ${editingCharacteristic.characteristic.name}` : "Add characteristic"}
              onClose={() => setEditingCharacteristic(null)}
              width="max-w-3xl">
              <CharacteristicForm
                revision={revision}
                characteristic={editingCharacteristic.characteristic}
                operationId={editingCharacteristic.operationId}
                onDone={() => setEditingCharacteristic(null)}
              />
            </Dialog>
          )}
          {editingReactions && (
            <Dialog title="General reactions" onClose={() => setEditingReactions(false)} width="max-w-3xl">
              <RevisionReactionsForm revision={revision} onDone={() => setEditingReactions(false)} />
            </Dialog>
          )}
        </>
      )}
    </div>
  );
};

export default RevisionPage;
