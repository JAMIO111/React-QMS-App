import { Link } from "react-router-dom";
import { CheckIcon } from "@/components/icons";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useOrganisationAccess, usePermissions } from "../../hooks/useQmsApi";
import { useOnboarding } from "../../hooks/useOnboarding";
import { SETUP_STEPS, resumeSetup, setupStepOf } from "../../lib/onboarding";

/**
 * Shown on the dashboard to people who can set the organisation up, until the set-up wizard is finished: how far along it is, what is still needed
 * before it can be finished, and the way back in. Gone for good once the owner finishes (and never shown for organisations that have no wizard).
 */
const OnboardingCard = () => {
  const { organisation } = useOrganisation();
  const { onboarding } = useOrganisationAccess();
  const { can } = usePermissions();
  const show = onboarding === "in_progress" && can("organisation.manage");
  const query = useOnboarding({ enabled: show });
  const state = query.data;
  if (!show || !state || state.completedAt) return null;

  const steps = SETUP_STEPS.map((def) => ({ ...def, ...state.steps.find((s) => s.key === def.key) }));
  const done = steps.filter((s) => s.status === "done").length;
  const next = setupStepOf(state.currentStep);
  const needed = steps.filter((s) => s.required && s.status !== "done").map((s) => s.label);
  const percent = Math.round((done / steps.length) * 100);

  return (
    <section aria-label="Set-up progress" className="flex flex-col gap-4 rounded-2xl border border-theme-light bg-theme-dark p-5 text-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Finish setting up {organisation?.name ?? "your organisation"}</h2>
          <p className="text-sm text-white/80">
            {done} of {steps.length} steps done. Your progress is saved and you can pick up where you left off.
          </p>
        </div>
        <Link
          to={`/setup/${next.key}`}
          onClick={resumeSetup}
          className="shrink-0 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-white/90">
          Continue set-up
        </Link>
      </div>

      <div role="progressbar" aria-label="Set-up progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 overflow-hidden rounded-full bg-white/25">
        <div className="h-full rounded-full bg-white transition-[width]" style={{ width: `${percent}%` }} />
      </div>

      <ol aria-label="Set-up steps" className="flex flex-wrap gap-2 text-xs">
        {steps.map((s) => (
          <li key={s.key}>
            <Link
              to={`/setup/${s.key}`}
              onClick={resumeSetup}
              aria-current={s.key === next.key ? "step" : undefined}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${s.key === next.key ? "border-white bg-white/20 font-semibold" : "border-white/30 hover:bg-white/10"}`}>
              {s.status === "done" ? <CheckIcon className="h-3 w-3" aria-label="Done" /> : null}
              {s.label}
              {s.status === "skipped" ? <span className="text-white/70">(skipped)</span> : null}
            </Link>
          </li>
        ))}
      </ol>

      <p className="text-sm text-white/90">
        <strong>Next:</strong> {next.title}.{" "}
        {needed.length > 0 ? `Still needed before you can finish: ${needed.join(", ")}.` : "Everything required is in place: review and finish when you are ready."}
      </p>
    </section>
  );
};

export default OnboardingCard;
