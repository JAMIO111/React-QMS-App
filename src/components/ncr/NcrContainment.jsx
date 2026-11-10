import { useState } from "react";
import { PencilIcon, PlusIcon, RotateCcwIcon } from "@/components/icons";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { ErrorNotice, FormError } from "../master-data/shared";
import ComboField from "../ui/ComboField";
import { TextAreaField } from "./Pickers";
import ReasonDialog from "./ReasonDialog";
import { useToast } from "../../contexts/ToastProvider";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { apiFetch } from "../../lib/api-client";
import { useOptimisticSubmit } from "../../lib/optimisticSubmit";
import { useEmployees, useNcrAffectedLots, useNcrContainment, useNcrMutation } from "../../hooks/useNcr";
import { CONTAINMENT_KINDS, containmentKindLabel } from "../../lib/ncrWorkflow";
import { formatDate } from "../../lib/ncr";
import CTAButton from "@/components/CTAButton";

const STATUS = {
  open: { label: "Open", tone: "bg-warning-color/15 text-primary-text" },
  done: { label: "Done", tone: "bg-success-color/15 text-success-color" },
  cancelled: { label: "Cancelled", tone: "bg-border-color text-secondary-text line-through" },
};
const when = (iso) => (iso ? formatDate(iso) : "—");
const toNumber = (text) => (String(text).trim() === "" ? null : Number(text));

/** Add or change a containment action (only an open one can be changed). */
const ActionDialog = ({ ncrId, action, lots, onClose }) => {
  const employees = useEmployees();
  const { organisationId } = useOrganisation();
  const submitOptimistically = useOptimisticSubmit();
  const [form, setForm] = useState({
    kind: action?.kind ?? "quarantine",
    description: action?.description ?? "",
    ownerEmployeeId: action?.owner?.id ?? null,
    dueDate: action?.dueDate ?? null,
    quantityContained: action?.quantityContained ?? "",
    lotId: action?.lot?.id ?? null,
  });
  const qtyValid = String(form.quantityContained).trim() === "" || (Number.isFinite(Number(form.quantityContained)) && Number(form.quantityContained) >= 0);
  const submit = (e) => {
    e.preventDefault();
    const body = { kind: form.kind, description: form.description.trim(), ownerEmployeeId: form.ownerEmployeeId, dueDate: form.dueDate, quantityContained: toNumber(form.quantityContained), lotId: form.lotId };
    if (!form.description.trim() || !qtyValid) return;
    const owner = (employees.data ?? []).find((e) => e.id === body.ownerEmployeeId);
    const lot = lots.find((l) => l.lot.id === body.lotId);
    const shown = { ...body, owner: owner ? { id: owner.id, name: owner.name } : null, lot: lot ? { id: lot.lot.id, lotNumber: lot.lot.lotNumber } : null };
    // The action appears in the list at once and the dialog closes; the server's version replaces it, or the list goes back and a message says why.
    onClose();
    submitOptimistically({
      request: () => apiFetch(action ? `/ncr-containment-actions/${action.id}` : `/ncrs/${ncrId}/containment-actions`, { method: action ? "PATCH" : "POST", body, organisationId }),
      patches: [{
        queryKey: ["api", "org", organisationId, "ncr", "containment", ncrId],
        update: (c) => ({
          ...c,
          actions: action
            ? c.actions.map((x) => (x.id === action.id ? { ...x, ...shown } : x))
            : [...c.actions, { id: `pending-${Date.now()}`, ...shown, status: "open", createdAt: new Date().toISOString() }],
        }),
      }],
      success: { title: "Saved", message: action ? "Containment action updated." : "Containment action added." },
      errorTitle: "Containment action not saved",
    });
  };
  return (
    <Dialog title={action ? "Edit containment action" : "Add a containment action"} onClose={onClose} width="max-w-xl">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <ComboField label="What kind of action is it?" required clearable={false} value={form.kind} onChange={(v) => setForm((f) => ({ ...f, kind: v }))} options={CONTAINMENT_KINDS} placeholder="Choose one" />
        <TextAreaField label="What is being done?" required value={form.description} onChange={(v) => setForm((f) => ({ ...f, description: v }))} maxLength={1000} rows={3} />
        <ComboField
          label="Owner"
          clearable
          value={form.ownerEmployeeId}
          onChange={(v) => setForm((f) => ({ ...f, ownerEmployeeId: v || null }))}
          options={(employees.data ?? []).filter((e) => e.active || e.id === form.ownerEmployeeId).map((e) => ({ value: e.id, label: e.name }))}
          placeholder="Not assigned"
        />
        {lots.length > 0 && (
          <ComboField
            label="Lot"
            clearable
            value={form.lotId}
            onChange={(v) => setForm((f) => ({ ...f, lotId: v || null }))}
            options={lots.map((l) => ({ value: l.lot.id, label: `${l.lot.lotNumber} (${l.quantity} affected)` }))}
            placeholder="Not for one lot"
          />
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <RHFDatePickerPopout label="Due" value={form.dueDate} onChange={(v) => setForm((f) => ({ ...f, dueDate: v }))} valueFormat="iso" clearable />
          <Field label="Quantity contained" inputMode="decimal" value={form.quantityContained} onChange={(e) => setForm((f) => ({ ...f, quantityContained: e.target.value }))} error={!qtyValid ? "Enter a number" : undefined} hint="Optional" />
        </div>
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!form.description.trim() || !qtyValid}>
            {action ? "Save" : "Add action"}
          </CTAButton>
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
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending || !note.trim() || !qtyValid} loading={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Mark done"}
          </CTAButton>
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
  const affectedLots = useNcrAffectedLots(ncrId);
  const lots = (affectedLots.data?.data ?? []).filter((a) => !a.removedAt);
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
                {a.lot && <span className="rounded-full border border-border-color px-2 py-0.5 text-xs text-secondary-text">Lot {a.lot.lotNumber}</span>}
                {String(a.id).startsWith("pending-") ? (
                  // Shown at once while it saves (optimistic): it has no real id yet, so nothing can be done to it.
                  <span className="ml-auto text-xs text-secondary-text" role="status">Saving…</span>
                ) : (
                <span className="ml-auto flex flex-wrap gap-2">
                  {canEdit && a.status === "open" && (
                    <>
                      <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setEditing(a)} aria-label={`Edit containment action: ${a.description}`}>
                        <PencilIcon className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                        Edit
                      </CTAButton>
                      <CTAButton buttonType="button" type="main" size="lg" onClick={() => setCompleting(a)}>
                        Done…
                      </CTAButton>
                      <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setCancelling(a)}>
                        Cancel
                      </CTAButton>
                    </>
                  )}
                  {canEdit && a.status !== "open" && (
                    <CTAButton buttonType="button" type="neutral" size="md" onClick={() => run({ path: `/ncr-containment-actions/${a.id}/reopen` })} disabled={mutation.isPending} loading={mutation.isPending}>
                      <RotateCcwIcon className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                      Reopen
                    </CTAButton>
                  )}
                </span>
                )}
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
          <CTAButton buttonType="button" type="neutral" size="md" className="flex items-center gap-1" onClick={() => setEditing("new")}>
            <PlusIcon className="h-4 w-4" aria-hidden="true" /> Add containment action
          </CTAButton>
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
                <CTAButton buttonType="button" type="neutral" size="md" onClick={() => saveReason(null)} disabled={mutation.isPending} loading={mutation.isPending}>
                  Clear
                </CTAButton>
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
              <CTAButton buttonType="button" type="neutral" size="md" onClick={submitReason} disabled={!reason.trim() || mutation.isPending} loading={mutation.isPending}>
                Save reason
              </CTAButton>
            </div>
          )}
        </div>
      )}
      {mutation.error && !editing && !completing && !cancelling && <FormError error={mutation.error} />}

      {editing && <ActionDialog ncrId={ncrId} action={editing === "new" ? null : editing} lots={lots} onClose={() => setEditing(null)} />}
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
