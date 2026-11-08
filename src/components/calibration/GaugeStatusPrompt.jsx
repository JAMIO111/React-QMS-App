import { useState } from "react";
import Dialog from "../ui/Dialog";
import { GAUGE_STATUSES, outcomeOf, statusAfterCalibration, statusOf } from "../../lib/calibration";
import CTAButton from "@/components/CTAButton";

const CHOICES = GAUGE_STATUSES.filter((s) => s.key !== "in_calibration");
const HELP = {
  active: "In use and counted towards due dates.",
  quarantined: "Do not use until it passes calibration.",
  out_of_service: "Taken out of use (for example awaiting repair).",
  retired: "Permanently withdrawn from use.",
  lost: "Cannot be found.",
};

/** Offered after a calibration is saved so the gauge's status can follow the result. */
const GaugeStatusPrompt = ({ gauge, calibration, onApply, onSkip }) => {
  const current = statusAfterCalibration(gauge.status, calibration.outcome);
  const suggested = calibration.outcome === "fail" ? (current === "active" ? "quarantined" : current) : "active";
  const [status, setStatus] = useState(suggested);
  const [reason, setReason] = useState(status === current ? gauge.statusReason ?? "" : "");
  const outcome = outcomeOf(calibration.outcome);
  const changed = status !== current;

  return (
    <Dialog title="Update gauge status?" onClose={onSkip}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onApply(status, status === "active" ? null : reason.trim() || null);
        }}>
        <p className="text-sm text-secondary-text">
          {calibration.reference} {outcome ? `finished with result ${outcome.label.toLowerCase()}` : "was recorded"}. {gauge.assetNumber} is currently{" "}
          <strong className="text-primary-text">{statusOf(current).label.toLowerCase()}</strong>. Choose what its status should be.
        </p>
        <div role="radiogroup" aria-label="Gauge status" className="flex flex-col gap-2">
          {CHOICES.map((s) => (
            <label
              key={s.key}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${status === s.key ? "border-brand-primary bg-brand-primary/5" : "border-border-color hover:border-border-dark-color"}`}>
              <input
                type="radio"
                name="gauge-status"
                className="mt-1"
                checked={status === s.key}
                onChange={() => {
                  setStatus(s.key);
                  if (s.key === "active") setReason("");
                }}
              />
              <span className="flex flex-col">
                <span className="font-medium text-primary-text">
                  {s.label}
                  {s.key === suggested && <span className="ml-2 text-xs font-normal text-brand-primary">Suggested</span>}
                  {s.key === current && <span className="ml-2 text-xs font-normal text-secondary-text">Current</span>}
                </span>
                <span className="text-xs text-secondary-text">{HELP[s.key]}</span>
              </span>
            </label>
          ))}
        </div>
        {status !== "active" && (
          <label className="flex flex-col gap-1 text-xs text-secondary-text">
            Reason (optional)
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              placeholder="e.g. damaged anvil"
              className="rounded-lg border border-border-color bg-text-input-color px-3 py-1.5 text-sm text-primary-text focus:outline-none focus:border-brand-primary"
            />
          </label>
        )}
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" onClick={onSkip} type="neutral" size="md">
            Keep {statusOf(current).label.toLowerCase()}
          </CTAButton>
          <CTAButton buttonType="submit" disabled={!changed} type="main" size="md" className="font-medium">
            Update status
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

export default GaugeStatusPrompt;
