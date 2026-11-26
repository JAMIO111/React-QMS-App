import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "../../contexts/ToastProvider";
import { usePpapDraft } from "../../hooks/usePpap";
import { describeApiError } from "../../lib/api-client";
import { ppapPath } from "../../lib/ppap";
import { NewPpapDialog } from "./PpapDialogs";

/**
 * Starts a PPAP from a record that suggests one (a released part revision, an approved change, a control plan revision). It asks what the record suggests, opens the start dialog with
 * that filled in (nothing is saved until the person saves it) and goes to the new submission. `pick` overrides the suggestion with what the person chose (a part, a customer).
 */
export const useRaisePpap = () => {
  const draft = usePpapDraft();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState(null);

  const start = (kind, id, pick = {}) =>
    draft.mutate(
      { kind, id },
      {
        onSuccess: (d) => {
          const partId = pick.part?.id ?? d.partId ?? null;
          const found = d.parts?.find((p) => p.id === partId);
          setDialog({
            part: partId ? { id: partId, name: pick.part?.name ?? found?.partNumber ?? "" } : null,
            partRevisionId: partId && partId === d.partId ? d.partRevisionId : null,
            customer: pick.customer ?? (d.customerId ? { id: d.customerId, name: d.customers?.find((c) => c.id === d.customerId)?.name ?? "" } : null),
            reason: d.reason,
            notes: d.notes,
            raisedFrom: { kind, id },
            source: d.source,
          });
        },
        onError: (err) => showToast({ type: "error", title: "Could not start a PPAP", message: describeApiError(err) }),
      }
    );

  const node = dialog ? <NewPpapDialog onClose={() => setDialog(null)} defaults={dialog} onSaved={(p) => p?.id && navigate(ppapPath(p.id))} /> : null;
  return { start, node, pending: draft.isPending };
};
