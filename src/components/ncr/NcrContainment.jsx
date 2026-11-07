import { useState } from "react";
import { PencilIcon, PlusIcon, RotateCcwIcon } from "@/components/icons";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { buttonClass, ErrorNotice, FormError, SelectField } from "../master-data/shared";
import { TextAreaField } from "./Pickers";
import ReasonDialog from "./ReasonDialog";
import { useToast } from "../../contexts/ToastProvider";
import { useEmployees, useNcrContainment, useNcrMutation } from "../../hooks/useNcr";
import { CONTAINMENT_KINDS, containmentKindLabel } from "../../lib/ncrWorkflow";
import { formatDate } from "../../lib/ncr";

const STATUS = {
  open: { label: "Open", tone: "bg-warning-color/15 text-primary-text" },
  done: { label: "Done", tone: "bg-success-color/15 text-success-color" },
  cancelled: { label: "Cancelled", tone: "bg-border-color text-secondary-text line-through" },
};
const when = (iso) => (iso ? formatDate(iso) : "—");
const toNumber = (text) => (String(text).trim() === "" ? null : Number(text));

/** Add or change a containment action (only an open one can be changed). */
const ActionDialog = ({ ncrId, action, onClose }) => {
  const employees = useEmployees();
  const mutation = useNcrMutation();
  const { showToast } = useToast();
  const [form, setForm] = useState({
    kind: action?.kind ?? "quarantine",
    description: action?.description ?? "",
    ownerEmployeeId: action?.owner?.id ?? null,
    dueDate: action?.dueDate ?? null,
    quantityContained: action?.quantityContained ?? "",
  });
  const qtyValid = String(form.quantityContained).trim() === "" || (Number.isFinite(Number(form.quantityContained)) && Number(form.quantityContained) >= 0);
  const submit = (e) => {
    e.preventDefault();
    const body = { kind: form.kind, description: form.description.trim(), ownerEmployeeId: form.ownerEmployeeId, dueDate: form.dueDate, quantityContained: toNumber(form.quantityContained) };
    mutation.mutate(action ? { path: `/ncr-containment-actions/${action.id}`, method: "PATCH", body } : { path: `/ncrs/${ncrId}/containment-actions`, body }, {
      onSuccess: () => {
        showToast({ type: "success", title: "Saved", message: action ? "Containment action updated." : "Containment action added." });
        onClose();
      },
    });
  };
  return (
    <Dialog title={action ? "Edit containment action" : "Add a containment action"} onClose={onClose} width="max-w-xl">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <SelectField label="What kind of action is it?" required value={form.kind} onChange={(v) => setForm((f) => ({ ...f, kind: v }))} options={CONTAINMENT_KINDS} placeholder="Choose one" />
        <TextAreaField label="What is being done?" required value={form.description} onChange={(v) => setForm((f) => ({ ...f, description: v }))} maxLength={1000} rows={3} />
        <SelectField
          label="Owner"
          value={form.ownerEmployeeId}
          onChange={(v) => setForm((f) => ({ ...f, ownerEmployeeId: v || null }))}
          options={(employees.data ?? []).filter((e) => e.active || e.id === form.ownerEmployeeId).map((e) => ({ value: e.id, label: e.name }))}
          placeholder="Not assigned"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <RHFDatePickerPopout label="Due" value={form.dueDate} onChange={(v) => setForm((f) => ({ ...f, dueDate: v }))} valueFormat="iso" clearable />
          <Field label="Quantity contained" inputMode="decimal" value={form.quantityContained} onChange={(e) => setForm((f) => ({ ...f, quantityContained: e.target.value }))} error={!qtyValid ? "Enter a number" : undefined} hint="Optional" />
        </div>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.neutral} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={buttonClass.primary} disabled={mutation.isPending || !form.description.trim() || !qtyValid}>
            {mutation.isPending ? "Saving…" : action ? "Save" : "Add action"}
          </button>
        </div>
      </form>
    </Dialog>
  );
};

/** Mark an action done: what was done and found is the evidence. */
const DoneDialog = ({ action, onClose }) => {
  const mutation = useNcrMutation();
  const { showToast } = useToast();
  const [note, setNote] = useState("");
  const [qty, setQty] = useState(action.quantityContained ?? "");
  const qtyValid = String(qty).trim() === "" || (Number.isFinite(Number(qty)) && Number(qty) >= 0);
  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      { path: `/ncr-containment-actions/${action.id}/complete`, body: { note: note.trim(), ...(String(qty).trim() !== "" ? { quantityContained: Number(qty) } : {}) } },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Saved", message: "Containment action done." });
          onClose();
        },
      }
    );
  };
  return (
    <Dialog title="Mark the action done" onClose={onClose} width="max-w-xl">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">{action.description}</p>
        <TextAreaField label="What was done and what was found?" required value={note} onChange={setNote} maxLength={2000} rows={3} />
        <Field label="Quantity contained" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} error={!qtyValid ? "Enter a number" : undefined} hint="Optional" />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.neutral} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={buttonClass.primary} disabled={mutation.isPending || !note.trim() || !qtyValid}>
            {mutation.isPending ? "Saving…" : "Mark done"}
          </button>
        </div>
      </form>
    </Dialog>
  );
};

/**
 * Containment of an NC: what is being done to stop suspect product going on, or why nothing is needed. Every action must be done or cancelled, and at least one
 * done (or a reason that none is needed), before the NC can reach Contained or anything beyond.
 */
const NcrContainment = ({ ncrId, canEdit }) => {
  const containment = useNcrContainment(ncrId);
  const mutation = useNcrMutation();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(null); // "new" | action
  const [completing, setCompleting] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const [reason, setReason] = useState("");
  const c = containment.data;

  if (containment.isLoading) return <LoadingScreen size="sm" />;
  if (containment.error) return <ErrorNotice error={containment.error} />;
  if (!c) return null;

  const run = (request, message) => mutation.mutate(request, { onSuccess: () => message && showToast({ type: "success", title: "Saved", message }) });
  const submitReason = () => {
    saveReason(reason.trim());
    setReason("");
  };
  const saveReason = (next) => run({ path: `/ncrs/${ncrId}/containment-reason`, method: "PUT", body: { reason: next } }, next ? "Reason saved." : "Reason cleared.");

  return (
    <div className="flex w-full flex-col gap-4">
      <div
        role="status"
        className={`rounded-lg border p-3 text-sm text-primary-text ${c.resolved ? "border-success-color/40 bg-success-color/10" : "border-warning-color/40 bg-warning-color/10"}`}>
        {c.resolved ? (
          <span>Containment is resolved{c.notNeededReason && c.actions.every((a) => a.status !== "done") ? ": none was needed." : "."}</span>
        ) : (
          <span>
            Still needed before this can be contained: <strong>{c.problems.join("; ")}</strong>.
          </span>
        )}
      </div>

      {c.actions.length === 0 ? (
        <p className="text-sm text-secondary-text">No containment actions yet.</p>
      ) : (
        <ul aria-label="Containment actions" className="flex flex-col gap-2">
          {c.actions.map((a) => (
            <li key={a.id} className="flex flex-col gap-1 rounded-xl border border-border-color bg-primary-bg p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[a.status].tone}`}>{STATUS[a.status].label}</span>
                <span className="text-xs text-secondary-text">{containmentKindLabel(a.kind)}</span>
                <span className="ml-auto flex flex-wrap gap-2">
                  {canEdit && a.status === "open" && (
                    <>
                      <button type="button" className={buttonClass.neutral} onClick={() => setEditing(a)} aria-label={`Edit containment action: ${a.description}`}>
                        <PencilIcon className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                        Edit
                      </button>
                      <button type="button" className={buttonClass.primary} onClick={() => setCompleting(a)}>
                        Done…
                      </button>
                      <button type="button" className={buttonClass.neutral} onClick={() => setCancelling(a)}>
                        Cancel
                      </button>
                    </>
                  )}
                  {canEdit && a.status !== "open" && (
                    <button type="button" className={buttonClass.neutral} onClick={() => run({ path: `/ncr-containment-actions/${a.id}/reopen` })} disabled={mutation.isPending}>
                      <RotateCcwIcon className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                      Reopen
                    </button>
                  )}
                </span>
              </div>
              <p className="text-sm text-primary-text">{a.description}</p>
              <p className="text-xs text-secondary-text">
                {a.owner ? `Owner ${a.owner.name}` : "No owner"}
                {a.dueDate ? ` · due ${formatDate(a.dueDate)}` : ""}
                {a.quantityContained != null ? ` · ${a.quantityContained} contained` : ""}
              </p>
              {a.status === "done" && (
                <p className="text-sm text-primary-text">
                  <span className="text-secondary-text">
                    Done {when(a.doneAt)} by {a.doneBy?.name ?? "—"}:
                  </span>{" "}
                  {a.doneNote}
                </p>
              )}
              {a.status === "cancelled" && <p className="text-sm text-primary-text">Cancelled: {a.cancelReason}</p>}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${buttonClass.neutral} flex items-center gap-1`} onClick={() => setEditing("new")}>
            <PlusIcon className="h-4 w-4" aria-hidden="true" /> Add containment action
          </button>
        </div>
      )}

      {(canEdit || c.notNeededReason) && (
        <div className="flex flex-col gap-2 rounded-xl border border-border-color p-3">
          {c.notNeededReason ? (
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="text-sm text-primary-text">
                <span className="text-secondary-text">No containment needed because: </span>
                {c.notNeededReason}
              </p>
              {canEdit && (
                <button type="button" className={buttonClass.neutral} onClick={() => saveReason(null)} disabled={mutation.isPending}>
                  Clear
                </button>
              )}
            </div>
          ) : (
            // Not a <form>: this card sits inside the NC page's own form.
            <div className="flex flex-wrap items-end gap-2">
              <Field
                label="Or say why no containment is needed"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (reason.trim()) submitReason();
                  }
                }}
                maxLength={500}
                className="min-w-64 flex-1"
              />
              <button type="button" className={buttonClass.neutral} onClick={submitReason} disabled={!reason.trim() || mutation.isPending}>
                Save reason
              </button>
            </div>
          )}
        </div>
      )}
      {mutation.error && !editing && !completing && !cancelling && <FormError error={mutation.error} />}

      {editing && <ActionDialog ncrId={ncrId} action={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {completing && <DoneDialog action={completing} onClose={() => setCompleting(null)} />}
      {cancelling && (
        <ReasonDialog
          title="Cancel this containment action?"
          label="Why is it being cancelled?"
          confirmText="Cancel action"
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setCancelling(null)}
          onConfirm={(r) => mutation.mutate({ path: `/ncr-containment-actions/${cancelling.id}/cancel`, body: { reason: r } }, { onSuccess: () => setCancelling(null) })}
        />
      )}
    </div>
  );
};

export default NcrContainment;
