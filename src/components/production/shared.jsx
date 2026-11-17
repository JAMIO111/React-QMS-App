import { useState } from "react";
import { useToast } from "../../contexts/ToastProvider";
import { useMasterDataMutation } from "../../hooks/useMasterData";
import { describeApiError } from "../../lib/api-client";
import ReasonDialog from "../ncr/ReasonDialog";
import CTAButton from "@/components/CTAButton";

export const StatusBadge = ({ map, status }) => {
  const s = map[status] ?? { label: status, className: "bg-border-color text-secondary-text" };
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.className}`}>{s.label}</span>;
};

/**
 * The buttons that move a record to its next status. A move that needs a reason asks for it first. The new status shows at once (the hook's guess, and
 * `onDone` with `record` moved for a dialog that keeps its own copy); the database decides whether the move is allowed and, if not, the status goes back and
 * its words show in an error toast, so nothing here repeats its rules.
 */
export const StatusMoves = ({ moves = [], path, noun, onDone, disabled, record }) => {
  const mutation = useMasterDataMutation();
  const { showToast } = useToast();
  const [asking, setAsking] = useState(null);
  const run = (move, reason) => {
    setAsking(null);
    if (record) onDone?.({ ...record, status: move.to, ...(reason ? { statusReason: reason } : {}) });
    mutation
      .mutateAsync({ path, method: "PATCH", body: { status: move.to, ...(reason ? { statusReason: reason } : {}) } })
      .then((data) => onDone?.(data))
      .catch((error) => {
        if (record) onDone?.(record);
        showToast({ type: "error", title: "Not changed", message: describeApiError(error) });
      });
  };
  if (!moves.length) return null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Change ${noun} status`}>
        {moves.map((m) => (
          <CTAButton key={m.to} type={m.danger ? "danger" : "secondary"} size="md" disabled={disabled} onClick={() => (m.reason ? setAsking(m) : run(m))}>
            {m.label}
          </CTAButton>
        ))}
      </div>
      {asking && <ReasonDialog title={asking.label} label={asking.reason} confirmText={asking.label} onClose={() => setAsking(null)} onConfirm={(reason) => run(asking, reason)} />}
    </>
  );
};
