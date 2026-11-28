import { useState } from "react";
import Switch from "@/components/ui/Switch";
import { ChevronDownIcon, ChevronUpIcon, PencilIcon, PlusIcon } from "@/components/icons";
import { useCalibrationMutation } from "../../hooks/useCalibration";
import { useQuickSave } from "../../hooks/useQuickSave";
import { appendRow, changeRecord } from "../../lib/guessRequest";
import { isPending, pendingId } from "../../lib/optimistic";
import { describeApiError } from "../../lib/api-client";
import { checkToForm, checkWords, isPercentCheck } from "../../lib/rangeChecks";
import { useToast } from "../../contexts/ToastProvider";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";
import { CheckDialog, EvenPointsDialog } from "./CheckDialogs";
import { RangeTry } from "./RangePreview";

/** The limits a guess shows before the server answers: only for a fixed check (a percentage check has none of its own). */
const guessLimits = (b) =>
  b.kind === "variable" && b.nominalBasis === "value" && b.toleranceBasis === "value"
    ? { lower: b.nominal - b.toleranceMinus, upper: b.nominal + b.tolerancePlus }
    : { lower: null, upper: null };

/**
 * A gauge type's checks (the template copied onto each new gauge): a fixed value or a percentage of the gauge's own range for the point, and a
 * tolerance given four ways. Checks are never removed: switch them off so past readings keep their meaning.
 */
const TypeChecks = ({ typeId, items = [], isLoading, error, canEdit, showInactive, onShowInactive }) => {
  const mutation = useCalibrationMutation();
  const quickSave = useQuickSave(mutation);
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null); // { check } | "new" | "even"
  const [trying, setTrying] = useState(false);
  const [adding, setAdding] = useState(false);
  const ordered = [...items].sort((a, b) => a.sortOrder - b.sortOrder);
  const base = `/gauge-types/${typeId}`;
  const itemBase = "/gauge-type-characteristics";
  const patch = (id, body) => quickSave({ path: `${itemBase}/${id}`, method: "PATCH", body });

  const move = (index, delta) => {
    const a = ordered[index];
    const b = ordered[index + delta];
    if (!a || !b) return;
    const [ao, bo] = a.sortOrder === b.sortOrder ? [index + delta + 1, index + 1] : [b.sortOrder, a.sortOrder];
    patch(a.id, { sortOrder: ao });
    patch(b.id, { sortOrder: bo });
  };
  const save = (c, body) => {
    setDialog(null);
    quickSave({ path: `${itemBase}/${c.id}`, method: "PATCH", body, guess: changeRecord(c.id, (x) => ({ ...x, ...body, ...guessLimits(body) })) });
  };
  const create = (body) => {
    setDialog(null);
    const row = { id: pendingId(), ...body, ...guessLimits(body), active: true, sortOrder: Math.max(0, ...items.map((c) => c.sortOrder ?? 0)) + 1 };
    quickSave({ path: `${base}/characteristics`, body, guess: appendRow([typeId, "characteristics"], row) }, "Not added");
  };
  /** Evenly spaced points go in one after another; the dialog stays until they are all made. */
  const createMany = async (bodies) => {
    setAdding(true);
    let made = 0;
    try {
      for (const body of bodies) {
        await mutation.mutateAsync({ path: `${base}/characteristics`, body });
        made += 1;
      }
      setDialog(null);
      showToast({ type: "success", title: "Checks added", message: `${made} ${made === 1 ? "check" : "checks"} added.` });
    } catch (err) {
      showToast({ type: "error", title: "Not all were added", message: `${made} of ${bodies.length} added. ${describeApiError(err)}` });
    } finally {
      setAdding(false);
    }
  };

  if (isLoading) return <LoadingScreen size="sm" />;
  if (error) return <Callout tone="error" role="alert">{describeApiError(error)}</Callout>;

  return (
    <div className="flex flex-col gap-3">
      {onShowInactive && (
        <Switch className="self-end text-sm text-secondary-text" checked={!!showInactive} onChange={(e) => onShowInactive(e.target.checked)}>
          Show switched-off
        </Switch>
      )}
      {dialog === "new" && <CheckDialog onClose={() => setDialog(null)} onSave={create} />}
      {dialog === "even" && <EvenPointsDialog onClose={() => setDialog(null)} onAdd={createMany} pending={adding} />}
      {dialog?.check && <CheckDialog check={checkToForm(dialog.check)} onClose={() => setDialog(null)} onSave={(body) => save(dialog.check, body)} />}
      {ordered.length === 0 ? (
        <p className="rounded-lg border-2 border-dashed border-border-dark-color p-4 text-center text-sm text-secondary-text">No template characteristics yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-left text-sm" aria-label="Gauge type checks">
            <thead className="text-secondary-text">
              <tr>
                <th className="w-28 px-1 py-1 font-medium">Type</th>
                <th className="px-1 py-1 font-medium">Check</th>
                <th className="px-1 py-1 font-medium">Point and tolerance</th>
                <th className="px-1 py-1 font-medium">Method</th>
                {canEdit && <th className="w-44 px-1 py-1"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody className="text-primary-text">
              {ordered.map((c, i) => (
                <tr key={c.id} className={`border-t border-border-color ${c.active ? "" : "opacity-60"}`}>
                  <td className="px-1 py-1.5">
                    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${c.kind === "attribute" ? "bg-theme/15 text-theme" : "bg-border-color text-primary-text"}`}>
                      {c.kind === "attribute" ? "Pass / fail" : "Measured"}
                    </span>
                  </td>
                  <td className="px-1 py-1.5">
                    {c.name}
                    {!c.active && <span className="ml-2 text-xs text-secondary-text">(switched off)</span>}
                    {isPercentCheck(c) && <span className="ml-2 inline-block rounded-full bg-info-color/15 px-2 py-0.5 text-xs font-medium text-info-color">From range</span>}
                  </td>
                  <td className="px-1 py-1.5">
                    {checkWords(c)}
                    {c.toleranceSource && <span className="block text-xs text-secondary-text">Source: {c.toleranceSource}</span>}
                  </td>
                  <td className="px-1 py-1.5 text-secondary-text">{c.method ?? "—"}</td>
                  {canEdit && isPending(c.id) && <td className="px-1 py-1.5 text-right text-xs text-secondary-text">Saving…</td>}
                  {canEdit && !isPending(c.id) && (
                    <td className="px-1 py-1.5">
                      <div className="flex items-center justify-end gap-1">
                        <button type="button" aria-label={`Move ${c.name} up`} disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 hover:bg-border-color/50 disabled:opacity-30 cursor-pointer"><ChevronUpIcon /></button>
                        <button type="button" aria-label={`Move ${c.name} down`} disabled={i === ordered.length - 1} onClick={() => move(i, 1)} className="rounded p-1 hover:bg-border-color/50 disabled:opacity-30 cursor-pointer"><ChevronDownIcon /></button>
                        <button type="button" aria-label={`Edit ${c.name}`} onClick={() => setDialog({ check: c })} className="rounded p-1 hover:bg-border-color/50 cursor-pointer"><PencilIcon /></button>
                        <button type="button" onClick={() => patch(c.id, { active: !c.active })} className="whitespace-nowrap rounded px-1 text-xs text-link-color hover:underline cursor-pointer">
                          {c.active ? "Switch off" : "Switch on"}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {canEdit && (
          <>
            <CTAButton buttonType="button" onClick={() => setDialog("new")} type="neutral" size="md" className="flex items-center gap-1 px-3 py-1">
              <PlusIcon /> Add characteristic
            </CTAButton>
            <CTAButton buttonType="button" onClick={() => setDialog("even")} type="neutral" size="md" className="flex items-center gap-1 px-3 py-1">
              <PlusIcon /> Add evenly spaced points
            </CTAButton>
          </>
        )}
        {ordered.length > 0 && (
          <CTAButton buttonType="button" onClick={() => setTrying((t) => !t)} type="secondary" size="md" className="px-3 py-1" aria-expanded={trying}>
            {trying ? "Hide the range try-out" : "Try it with a range"}
          </CTAButton>
        )}
      </div>
      {trying && <RangeTry typeId={typeId} />}
    </div>
  );
};

export default TypeChecks;
