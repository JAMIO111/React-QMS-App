import { useCalibrationMutation } from "../../hooks/useCalibration";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";

/**
 * Shown above a gauge's checks when some are worked out from the gauge type and its range and the range (or the type) has changed since:
 * a check keeps its numbers until someone asks for them again, so past and future calibrations never change without a person choosing it.
 * Also says which checks cannot be worked out now (for example the range was cleared).
 */
const RangeChecksNotice = ({ gaugeId, items = [], canEdit }) => {
  const recalc = useCalibrationMutation();
  const { showToast } = useToast();
  const live = items.filter((c) => c.followsRange && c.active);
  const stale = live.filter((c) => c.staleFromRange);
  const stuck = live.filter((c) => c.rangeProblem);
  if (!stale.length && !stuck.length) return null;

  const run = () =>
    recalc.mutate(
      { path: `/gauges/${gaugeId}/recalculate-range-checks`, method: "POST" },
      {
        onSuccess: (r) => {
          const n = r?.result?.updated ?? 0;
          const left = r?.result?.problems?.length ?? 0;
          showToast({
            type: left ? "warning" : "success",
            title: "Checks recalculated",
            message: `${n} ${n === 1 ? "check" : "checks"} changed.${left ? ` ${left} could not be worked out.` : ""} Calibrations already recorded keep the limits they were recorded with.`,
          });
        },
        onError: (err) => showToast({ type: "error", title: "Not recalculated", message: describeApiError(err) }),
      },
    );

  return (
    <Callout
      tone="warning"
      title={stale.length ? `${stale.length} ${stale.length === 1 ? "check is" : "checks are"} out of date` : "Some checks cannot be worked out"}
      action={
        canEdit && stale.length > 0 && (
          <CTAButton type="main" size="md" onClick={run} loading={recalc.isPending} loadingText="Recalculating…">
            Recalculate range-based checks
          </CTAButton>
        )
      }>
      {stale.length > 0 && "The range or the gauge type has changed since these checks were worked out, so they still show the old points and limits. "}
      {stale.length > 0 && (canEdit ? "Recalculating works them out again from the type and this gauge's range. " : "Someone who manages calibration can recalculate them. ")}
      {stale.length > 0 && "Calibrations already recorded keep the limits they were recorded with."}
      {stuck.length > 0 && (
        <ul className="mt-2 list-disc pl-5">
          {stuck.map((c) => (
            <li key={c.id}>{c.name}: {c.rangeProblem}</li>
          ))}
        </ul>
      )}
    </Callout>
  );
};

export default RangeChecksNotice;
