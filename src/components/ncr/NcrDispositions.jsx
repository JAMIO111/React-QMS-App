import { useState } from "react";
import { CheckIcon, PencilIcon, PlusIcon, Undo2Icon } from "@/components/icons";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import { ErrorNotice, FormError } from "../master-data/shared";
import ComboField from "../ui/ComboField";
import { TextAreaField } from "./Pickers";
import ReasonDialog from "./ReasonDialog";
import { useToast } from "../../contexts/ToastProvider";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { apiFetch } from "../../lib/api-client";
import { useOptimisticSubmit } from "../../lib/optimisticSubmit";
import { useNcrAffectedLots, useNcrDispositions, useNcrMutation } from "../../hooks/useNcr";
import { DISPOSITION_DECISIONS, RMA_DECISION, decisionLabel } from "../../lib/ncrWorkflow";
import { formatDate } from "../../lib/ncr";
import CTAButton from "@/components/CTAButton";

const STATUS = {
  proposed: { label: "Proposed", tone: "bg-warning-color/15 text-primary-text" },
  approved: { label: "Approved", tone: "bg-success-color/15 text-success-color" },
  cancelled: { label: "Cancelled", tone: "bg-border-color text-secondary-text line-through" },
};

/** Propose or change a disposition (only a proposed one can be changed). */
const DispositionDialog = ({ ncrId, disposition, remaining: remainingNow, lots: lotsNow, onClose }) => {
  const { organisationId } = useOrganisation();
  const submitOptimistically = useOptimisticSubmit();
  // What is left to decide is fixed when the dialog opens: the saved result changes the numbers behind it, and that must never make a valid entry look wrong.
  const [{ remaining, lots }] = useState({ remaining: remainingNow, lots: lotsNow });
  const [form, setForm] = useState({
    decision: disposition?.decision ?? "scrap",
    quantity: disposition?.quantity ?? (remaining > 0 ? remaining : ""),
    instructions: disposition?.instructions ?? "",
    reference: disposition?.reference ?? "",
    lotId: disposition?.lot?.id ?? null,
  });
  // A customer return keeps its decision and its RMA number: only the quantity, lot and instructions can change.
  const isRma = disposition?.decision === RMA_DECISION;
  // A disposition naming a lot also has to fit what is left of that lot.
  const lot = lots.find((l) => l.lot.id === form.lotId);
  const lotLeft = lot ? lot.quantity - lot.approvedQuantity - lot.proposedQuantity + (disposition?.lot?.id === lot.lot.id ? disposition.quantity : 0) : Infinity;
  const max = Math.min((remaining ?? 0) + (disposition?.quantity ?? 0), lotLeft);
  const qty = Number(form.quantity);
  const qtyOk = String(form.quantity).trim() !== "" && Number.isFinite(qty) && qty > 0 && qty <= max;
  const submit = (e) => {
    e.preventDefault();
    if (!qtyOk || !form.instructions.trim()) return;
    const body = isRma
      ? { quantity: qty, instructions: form.instructions.trim(), lotId: form.lotId }
      : { decision: form.decision, quantity: qty, instructions: form.instructions.trim(), reference: form.reference.trim() || null, lotId: form.lotId };
    const chosenLot = lots.find((l) => l.lot.id === body.lotId);
    const delta = qty - (disposition?.quantity ?? 0);
    // The list shows the proposal at once; the dialog closes; the server's version replaces it a moment later (or the list goes back and a message says why).
    onClose();
    submitOptimistically({
      request: () => apiFetch(disposition ? `/ncr-dispositions/${disposition.id}` : `/ncrs/${ncrId}/dispositions`, { method: disposition ? "PATCH" : "POST", body, organisationId }),
      patches: [{
        queryKey: ["api", "org", organisationId, "ncr", "dispositions", ncrId],
        update: (d) => ({
          ...d,
          data: disposition
            ? d.data.map((x) => (x.id === disposition.id ? { ...x, ...body, lot: chosenLot ? { id: chosenLot.lot.id, lotNumber: chosenLot.lot.lotNumber } : null } : x))
            : [...d.data, { id: `pending-${Date.now()}`, ...body, status: "proposed", lot: chosenLot ? { id: chosenLot.lot.id, lotNumber: chosenLot.lot.lotNumber } : null, createdAt: new Date().toISOString(), createdBy: null }],
          proposedQuantity: (d.proposedQuantity ?? 0) + delta,
          remaining: (d.remaining ?? 0) - delta,
        }),
      }],
      success: { title: "Saved", message: disposition ? "Disposition updated." : "Disposition proposed." },
      errorTitle: "Disposition not saved",
    });
  };
  return (
    <Dialog title={disposition ? "Edit the proposed disposition" : "Propose a disposition"} onClose={onClose} width="max-w-xl">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        {isRma ? (
          <p className="text-sm text-primary-text">
            <strong>{decisionLabel(RMA_DECISION)}</strong> · {disposition.reference}. The decision and the RMA number cannot be changed.
          </p>
        ) : (
          <ComboField label="Decision" required clearable={false} value={form.decision} onChange={(v) => setForm((f) => ({ ...f, decision: v }))} options={DISPOSITION_DECISIONS} placeholder="Choose one" />
        )}
        {lots.length > 0 && (
          <ComboField
            label="Lot"
            clearable
            value={form.lotId}
            onChange={(v) => setForm((f) => ({ ...f, lotId: v || null }))}
            options={lots.map((l) => ({ value: l.lot.id, label: `${l.lot.lotNumber} (${l.quantity} affected)` }))}
            placeholder="Not for one lot"
            hint="Each affected lot needs approved dispositions that cover it"
          />
        )}
        <Field
          label="Quantity"
          required
          inputMode="decimal"
          value={form.quantity}
          onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
          error={String(form.quantity).trim() !== "" && !qtyOk ? `Enter a number above 0 and up to ${max}` : undefined}
          hint={`Up to ${max} of the affected items ${lot ? "of this lot " : ""}are not yet covered`}
        />
        <TextAreaField label="Instructions" required value={form.instructions} onChange={(v) => setForm((f) => ({ ...f, instructions: v }))} maxLength={2000} rows={3} />
        {!isRma && (
          <Field
            label="Reference"
            value={form.reference}
            onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
            maxLength={200}
            required={form.decision === "concession"}
            hint={form.decision === "concession" ? "The customer's written approval: needed before a concession can be approved" : "Optional: a rework order, scrap note…"}
          />
        )}
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!qtyOk || !form.instructions.trim()}>
            {disposition ? "Save" : "Propose"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Generate an RMA number for all or part of what is still to decide: it becomes a proposed "customer return" disposition. The database gives the number. */
const RmaDialog = ({ ncrId, remaining: remainingNow, lots: lotsNow, onClose }) => {
  const mutation = useNcrMutation();
  const { showToast } = useToast();
  const [{ remaining, lots }] = useState({ remaining: remainingNow, lots: lotsNow });
  const [form, setForm] = useState({ quantity: remaining > 0 ? remaining : "", instructions: "", lotId: null });
  const lot = lots.find((l) => l.lot.id === form.lotId);
  const max = Math.min(remaining ?? 0, lot ? lot.quantity - lot.approvedQuantity - lot.proposedQuantity : Infinity);
  const qty = Number(form.quantity);
  const qtyOk = String(form.quantity).trim() !== "" && Number.isFinite(qty) && qty > 0 && qty <= max;
  const submit = (e) => {
    e.preventDefault();
    if (!qtyOk) return;
    mutation.mutate(
      { path: `/ncrs/${ncrId}/rma`, body: { quantity: qty, instructions: form.instructions.trim() || null, lotId: form.lotId } },
      {
        onSuccess: (made) => {
          showToast({ type: "success", title: made?.reference ?? "RMA number generated", message: `Customer return of ${qty} proposed${made?.reference ? ` under ${made.reference}` : ""}.` });
          onClose();
        },
      }
    );
  };
  return (
    <Dialog title="Generate an RMA number" onClose={onClose} width="max-w-xl">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">
          The customer returns these parts under a new RMA number. It is recorded as the disposition for this quantity and, like any disposition, takes effect once approved.
        </p>
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
        <Field
          label="Quantity to return"
          required
          inputMode="decimal"
          value={form.quantity}
          onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
          error={String(form.quantity).trim() !== "" && !qtyOk ? `Enter a number above 0 and up to ${max}` : undefined}
          hint={`All ${max} not yet covered${lot ? " of this lot" : ""}, or part of them`}
        />
        <TextAreaField label="Return instructions (optional)" value={form.instructions} onChange={(v) => setForm((f) => ({ ...f, instructions: v }))} maxLength={2000} rows={3} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!qtyOk || mutation.isPending} loading={mutation.isPending} loadingText="Generating…">
            Generate RMA number
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const ApproveDialog = ({ disposition, onClose }) => {
  const mutation = useNcrMutation();
  const { showToast } = useToast();
  const [note, setNote] = useState("");
  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      { path: `/ncr-dispositions/${disposition.id}/approve`, body: note.trim() ? { note: note.trim() } : {} },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Approved", message: `${decisionLabel(disposition.decision)} of ${disposition.quantity} approved.` });
          onClose();
        },
      }
    );
  };
  return (
    <Dialog title="Approve this disposition" onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <p className="text-sm text-primary-text">
          <strong>
            {decisionLabel(disposition.decision)} · {disposition.quantity}
          </strong>
          . {disposition.instructions}
          {disposition.reference ? ` (Reference: ${disposition.reference})` : ""}
        </p>
        <p className="text-sm text-secondary-text">Once approved it cannot be edited. To change it, cancel it and propose another.</p>
        <TextAreaField label="Note (optional)" value={note} onChange={setNote} maxLength={1000} rows={2} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending} loading={mutation.isPending}>
            {mutation.isPending ? "Approving…" : "Approve"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/**
 * What happens to the affected items: decisions for quantities, proposed by anyone who can edit the NC and approved by an approver. Approved dispositions must
 * cover the whole quantity affected (and none may be left proposed) before the NC can reach Dispositioned or anything beyond.
 */
const NcrDispositions = ({ ncrId, canEdit, source }) => {
  const dispositions = useNcrDispositions(ncrId);
  const mutation = useNcrMutation();
  const [editing, setEditing] = useState(null); // "new" | disposition
  const [approving, setApproving] = useState(null);
  const [rma, setRma] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const affectedLots = useNcrAffectedLots(ncrId);
  const lots = (affectedLots.data?.data ?? []).filter((a) => !a.removedAt);
  const d = dispositions.data;

  if (dispositions.isLoading) return <LoadingScreen size="sm" />;
  if (dispositions.error) return <ErrorNotice error={dispositions.error} />;
  if (!d) return null;

  const live = d.data.filter((x) => x.status !== "cancelled");
  return (
    <div className="flex w-full flex-col gap-4">
      <dl aria-label="Quantities" className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        {[
          ["Affected", d.affected ?? "—"],
          ["Approved", d.approvedQuantity],
          ["Proposed", d.proposedQuantity],
          ["Still to decide", d.remaining],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-border-color bg-primary-bg p-3">
            <dt className="text-secondary-text">{k}</dt>
            <dd className="text-xl font-semibold text-primary-text">{v}</dd>
          </div>
        ))}
      </dl>
      <div role="status" className={`rounded-lg border p-3 text-sm text-primary-text ${d.settled ? "border-success-color/40 bg-success-color/10" : "border-warning-color/40 bg-warning-color/10"}`}>
        {d.settled ? "Approved dispositions cover everything affected." : <>Still needed before this can be dispositioned: <strong>{d.problems.join("; ")}</strong>.</>}
      </div>

      {d.data.length === 0 ? (
        <p className="text-sm text-secondary-text">No dispositions yet.</p>
      ) : (
        <ul aria-label="Dispositions" className="flex flex-col gap-2">
          {d.data.map((x) => (
            <li key={x.id} className="flex flex-col gap-1 rounded-xl border border-border-color bg-primary-bg p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[x.status].tone}`}>{STATUS[x.status].label}</span>
                <span className="text-sm font-medium text-primary-text">
                  {decisionLabel(x.decision)} · {x.quantity}
                </span>
                {x.lot && <span className="rounded-full border border-border-color px-2 py-0.5 text-xs text-secondary-text">Lot {x.lot.lotNumber}</span>}
                {String(x.id).startsWith("pending-") ? (
                  // Shown at once while it saves (optimistic): it has no real id yet, so nothing can be done to it.
                  <span className="ml-auto text-xs text-secondary-text" role="status">Saving…</span>
                ) : (
                <span className="ml-auto flex flex-wrap gap-2">
                  {x.status === "proposed" && d.canApprove && (
                    <CTAButton buttonType="button" type="main" size="lg" onClick={() => setApproving(x)}>
                      <CheckIcon className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                      Approve…
                    </CTAButton>
                  )}
                  {x.status === "proposed" && canEdit && (
                    <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setEditing(x)} aria-label={`Edit ${decisionLabel(x.decision)} of ${x.quantity}`}>
                      <PencilIcon className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                      Edit
                    </CTAButton>
                  )}
                  {((x.status === "proposed" && canEdit) || (x.status === "approved" && canEdit && d.canApprove)) && (
                    <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setCancelling(x)} aria-label={`Cancel ${decisionLabel(x.decision)} of ${x.quantity}`}>
                      Cancel
                    </CTAButton>
                  )}
                </span>
                )}
              </div>
              <p className="text-sm text-primary-text">{x.instructions}</p>
              {x.reference && (
                <p className="text-xs text-secondary-text">
                  {x.decision === RMA_DECISION ? "RMA number" : "Reference"}: <span className={x.decision === RMA_DECISION ? "font-semibold text-primary-text" : undefined}>{x.reference}</span>
                </p>
              )}
              <p className="text-xs text-secondary-text">
                Proposed {formatDate(x.createdAt)} by {x.createdBy?.name ?? "—"}
                {x.status === "approved" && ` · approved ${formatDate(x.approvedAt)} by ${x.approvedBy?.name ?? "—"}${x.approvalNote ? `: ${x.approvalNote}` : ""}`}
                {x.status === "cancelled" && ` · cancelled ${formatDate(x.cancelledAt)} by ${x.cancelledBy?.name ?? "—"}: ${x.cancelReason}`}
              </p>
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" className="flex items-center gap-1" onClick={() => setEditing("new")} disabled={d.remaining <= 0}>
            <PlusIcon className="h-4 w-4" aria-hidden="true" /> Propose a disposition
          </CTAButton>
          {source === "customer" && (
            <CTAButton buttonType="button" type="secondary" size="md" className="flex items-center gap-1" onClick={() => setRma(true)} disabled={d.remaining <= 0}>
              <Undo2Icon className="h-4 w-4" aria-hidden="true" /> Generate an RMA number
            </CTAButton>
          )}
          {d.remaining <= 0 && live.length > 0 && <span className="text-xs text-secondary-text">Everything affected already has a disposition.</span>}
        </div>
      )}
      {!d.canApprove && live.some((x) => x.status === "proposed") && <p className="text-sm text-secondary-text">Proposed dispositions are approved by someone with approval rights.</p>}
      {mutation.error && !editing && !approving && !cancelling && !rma && <FormError error={mutation.error} />}

      {editing && <DispositionDialog ncrId={ncrId} disposition={editing === "new" ? null : editing} remaining={d.remaining} lots={lots} onClose={() => setEditing(null)} />}
      {rma && <RmaDialog ncrId={ncrId} remaining={d.remaining} lots={lots} onClose={() => setRma(false)} />}
      {approving && <ApproveDialog disposition={approving} onClose={() => setApproving(null)} />}
      {cancelling && (
        <ReasonDialog
          title={`Cancel this ${cancelling.status === "approved" ? "approved " : ""}disposition?`}
          label="Why is it being cancelled?"
          confirmText="Cancel disposition"
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setCancelling(null)}
          onConfirm={(r) => mutation.mutate({ path: `/ncr-dispositions/${cancelling.id}/cancel`, body: { reason: r } }, { onSuccess: () => setCancelling(null) })}
        />
      )}
    </div>
  );
};

export default NcrDispositions;
