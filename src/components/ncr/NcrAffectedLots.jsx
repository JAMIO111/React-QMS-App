import { useState } from "react";
import { PencilIcon, PlusIcon, RotateCcwIcon } from "@/components/icons";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import { ErrorNotice, FormError } from "../master-data/shared";
import { LotPicker } from "../production/pickers";
import { TextAreaField } from "./Pickers";
import ReasonDialog from "./ReasonDialog";
import { useToast } from "../../contexts/ToastProvider";
import { useNcrAffectedLots, useNcrMutation } from "../../hooks/useNcr";
import { useSerialLookup } from "../../hooks/useProduction";
import { formatDate } from "../../lib/ncr";
import CTAButton from "@/components/CTAButton";

/** Add or change an affected lot: the lot (fixed once added), how many of its items, which serial numbers and a note. */
const LotDialog = ({ ncrId, partId, row, lot, remaining, onClose }) => {
  const mutation = useNcrMutation();
  const { showToast } = useToast();
  const [picked, setPicked] = useState(row ? { id: row.lot.id, name: row.lot.lotNumber } : lot ? { id: lot.id, name: lot.lotNumber } : null);
  const [quantity, setQuantity] = useState(row?.quantity ?? (remaining > 0 ? remaining : ""));
  const [serialIds, setSerialIds] = useState(row?.serials.map((s) => s.id) ?? []);
  const [note, setNote] = useState(row?.note ?? "");
  const serials = useSerialLookup({ lotId: picked?.id }, { enabled: !!picked?.id });
  const max = (remaining ?? 0) + (row?.quantity ?? 0);
  const qty = Number(quantity);
  const qtyOk = String(quantity).trim() !== "" && Number.isFinite(qty) && qty > 0 && qty <= max;
  const submit = (e) => {
    e.preventDefault();
    const body = { quantity: qty, serialIds, note: note.trim() || null };
    mutation.mutate(row ? { path: `/ncr-affected-lots/${row.id}`, method: "PATCH", body } : { path: `/ncrs/${ncrId}/affected-lots`, body: { ...body, lotId: picked.id } }, {
      onSuccess: () => {
        showToast({ type: "success", title: "Saved", message: row ? "Affected lot updated." : "Lot added to this non-conformance." });
        onClose();
      },
    });
  };
  const toggle = (id) => setSerialIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <Dialog title={row ? `Edit lot ${row.lot.lotNumber}` : "Add an affected lot"} onClose={onClose} width="max-w-xl">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        {row ? (
          <p className="text-sm text-primary-text">
            Lot <strong>{row.lot.lotNumber}</strong>
          </p>
        ) : (
          <LotPicker label="Lot" required partId={partId} value={picked?.id ?? null} current={picked ? { id: picked.id, lotNumber: picked.name } : undefined} onChange={(id, item) => { setPicked(id ? { id, name: item?.name } : null); setSerialIds([]); }} />
        )}
        <Field
          label="How many items of this lot are affected"
          required
          inputMode="decimal"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          error={String(quantity).trim() !== "" && !qtyOk ? `Enter a number above 0 and up to ${max}` : undefined}
          hint={`Up to ${max} of the affected items are not yet placed in a lot`}
        />
        {picked && (serials.data ?? []).length > 0 && (
          <fieldset>
            <legend className="text-sm font-medium">Serial numbers affected (optional)</legend>
            <div className="mt-1 flex max-h-40 flex-wrap gap-1 overflow-y-auto">
              {serials.data.map((s) => (
                <label key={s.id} className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs ${serialIds.includes(s.id) ? "border-brand-primary bg-brand-primary text-white" : "border-border-color hover:bg-border-color/40"}`}>
                  <input type="checkbox" className="sr-only" checked={serialIds.includes(s.id)} onChange={() => toggle(s.id)} />
                  {s.serialNumber}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <TextAreaField label="Note" value={note} onChange={setNote} maxLength={1000} rows={2} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending || !qtyOk || !picked}>
            {mutation.isPending ? "Saving…" : row ? "Save" : "Add lot"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/**
 * The lots this non-conformance touches, with how many items of each, and how far the approved dispositions naming each lot cover it. Optional: a non-conformance that
 * names no lot (a shop working to work orders) stands against its order and its quantity affected exactly as before. Shown only while the organisation uses lots.
 */
const NcrAffectedLots = ({ ncrId, partId, canEdit }) => {
  const lots = useNcrAffectedLots(ncrId);
  const mutation = useNcrMutation();
  const [editing, setEditing] = useState(null); // "new" | row | { suggested }
  const [removing, setRemoving] = useState(null);
  const d = lots.data;

  if (lots.isLoading) return <LoadingScreen size="sm" />;
  if (lots.error) return <ErrorNotice error={lots.error} />;
  if (!d) return null;

  const live = d.data.filter((a) => !a.removedAt);
  const removed = d.data.filter((a) => a.removedAt);
  return (
    <div className="flex w-full flex-col gap-4">
      <dl aria-label="Lot quantities" className="grid grid-cols-3 gap-3 text-sm">
        {[
          ["Affected", d.affected ?? "—"],
          ["In lots", d.assigned],
          ["Not in a lot", d.remaining],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-border-color bg-primary-bg p-3">
            <dt className="text-secondary-text">{k}</dt>
            <dd className="text-xl font-semibold text-primary-text">{v}</dd>
          </div>
        ))}
      </dl>

      {d.suggestedLot && canEdit && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-border-color bg-secondary-bg p-3 text-sm text-primary-text">
          <span>
            This non-conformance is linked to lot <strong>{d.suggestedLot.lotNumber}</strong>, which is not listed here yet.
          </span>
          <CTAButton buttonType="button" type="neutral" size="md" className="ml-auto" onClick={() => setEditing({ suggested: d.suggestedLot })}>
            Add lot {d.suggestedLot.lotNumber}…
          </CTAButton>
        </div>
      )}

      {live.length === 0 ? (
        <p className="text-sm text-secondary-text">No lots named. The quantity affected stands against the production order as a whole.</p>
      ) : (
        <ul aria-label="Affected lots" className="flex flex-col gap-2">
          {live.map((a) => (
            <li key={a.id} className="flex flex-col gap-1 rounded-xl border border-border-color bg-primary-bg p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-primary-text">
                  {a.lot.lotNumber} · {a.quantity}
                </span>
                {a.lot.status === "on_hold" && <span className="rounded-full bg-warning-color/15 px-2 py-0.5 text-xs">On hold</span>}
                <span className="text-xs text-secondary-text">
                  {a.approvedQuantity} of {a.quantity} approved{a.proposedQuantity > 0 ? `, ${a.proposedQuantity} proposed` : ""}
                </span>
                {canEdit && (
                  <span className="ml-auto flex flex-wrap gap-2">
                    <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setEditing(a)} aria-label={`Edit lot ${a.lot.lotNumber}`}>
                      <PencilIcon className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                      Edit
                    </CTAButton>
                    <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setRemoving(a)} aria-label={`Remove lot ${a.lot.lotNumber}`}>
                      Remove
                    </CTAButton>
                  </span>
                )}
              </div>
              {a.serials.length > 0 && <p className="text-xs text-secondary-text">Serial numbers: {a.serials.map((s) => s.serialNumber).join(", ")}</p>}
              {a.note && <p className="text-sm text-primary-text">{a.note}</p>}
            </li>
          ))}
        </ul>
      )}

      {removed.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-secondary-text">Removed lots ({removed.length})</summary>
          <ul aria-label="Removed lots" className="mt-2 flex flex-col gap-2">
            {removed.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border-color bg-primary-bg p-3">
                <span className="text-primary-text line-through">
                  {a.lot.lotNumber} · {a.quantity}
                </span>
                <span className="text-xs text-secondary-text">
                  removed {formatDate(a.removedAt)} by {a.removedBy?.name ?? "—"}: {a.removedReason}
                </span>
                {canEdit && (
                  <CTAButton buttonType="button" type="neutral" size="md" className="ml-auto" onClick={() => mutation.mutate({ path: `/ncr-affected-lots/${a.id}/restore` })} disabled={mutation.isPending} aria-label={`Restore lot ${a.lot.lotNumber}`}>
                    <RotateCcwIcon className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                    Restore
                  </CTAButton>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" className="flex items-center gap-1" onClick={() => setEditing("new")} disabled={d.remaining <= 0}>
            <PlusIcon className="h-4 w-4" aria-hidden="true" /> Add a lot
          </CTAButton>
          {d.remaining <= 0 && <span className="text-xs text-secondary-text">Every affected item is already placed in a lot.</span>}
        </div>
      )}
      {mutation.error && !editing && !removing && <FormError error={mutation.error} />}

      {editing && (
        <LotDialog ncrId={ncrId} partId={partId} row={editing.id ? editing : null} lot={editing.suggested ?? null} remaining={d.remaining} onClose={() => setEditing(null)} />
      )}
      {removing && (
        <ReasonDialog
          title={`Remove lot ${removing.lot.lotNumber}?`}
          label="Why is it being removed?"
          confirmText="Remove lot"
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setRemoving(null)}
          onConfirm={(r) => mutation.mutate({ path: `/ncr-affected-lots/${removing.id}/remove`, body: { reason: r } }, { onSuccess: () => setRemoving(null) })}
        />
      )}
    </div>
  );
};

export default NcrAffectedLots;
