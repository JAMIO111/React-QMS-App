import { useRef } from "react";
import { useNavigate, useParams, Link, Navigate } from "react-router-dom";
import { CheckIcon, LockIcon } from "@/components/icons";
import FortressMark from "../../assets/fortress-qms.png";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useOnboarding, useOnboardingMutation } from "../../hooks/useOnboarding";
import { MARKABLE_STEPS, SETUP_STEPS, currentSetupStep, deferSetup, pageStatus, resumeSetup, setupStepIndex, setupStepOf } from "../../lib/onboarding";
import { ErrorNotice } from "../master-data/shared";
import WizardFooter from "./WizardFooter";
import ReviewStep from "./ReviewStep";
import { OrganisationStep, PlanStep, SecurityStep, SitesStep, TeamStep } from "./steps";
import CTAButton from "@/components/CTAButton";

const PAGES = { organisation: OrganisationStep, sites: SitesStep, security: SecurityStep, team: TeamStep, plan: PlanStep, review: ReviewStep };

const Rail = ({ state, active, lockedFrom }) => (
  <nav aria-label="Set-up steps" className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
    {SETUP_STEPS.map((s, i) => {
      const st = pageStatus(state, s.key);
      const locked = lockedFrom !== null && i >= lockedFrom;
      const isActive = s.key === active;
      const inner = (
        <>
          <span className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors ${st.status === "done" ? "bg-success-color text-white" : isActive ? "bg-brand-primary text-cta-btn-text shadow-md" : "border border-border-color bg-primary-bg text-secondary-text"}`}>
            {st.status === "done" ? <CheckIcon className="h-4 w-4" aria-label="Done" /> : locked ? <LockIcon className="h-3.5 w-3.5" aria-label="Locked" /> : i + 1}
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className={`truncate ${isActive ? "font-semibold text-primary-text" : ""}`}>{s.label}</span>
            <span className="text-xs text-secondary-text">{s.key === "review" ? "Final step" : st.status === "skipped" ? "Skipped" : st.required ? "Required" : "Optional"}</span>
          </span>
        </>
      );
      const cls = `relative flex min-w-[9rem] items-center gap-3 rounded-xl border px-3 py-2 text-sm transition-colors lg:min-w-0 ${isActive ? "border-brand-primary/50 bg-brand-primary/10 text-primary-text" : "border-transparent text-secondary-text"}`;
      // A thin line joins each step to the next on wide screens, so the steps read as one path.
      const line = i < SETUP_STEPS.length - 1 ? <span aria-hidden="true" className={`absolute left-[1.75rem] top-[2.4rem] hidden h-[calc(100%-1.4rem)] w-px lg:block ${st.status === "done" ? "bg-success-color/60" : "bg-border-color"}`} /> : null;
      return locked ? (
        <span key={s.key} aria-disabled="true" title="Available once your plan is active" className={`${cls} opacity-60`}>{line}{inner}</span>
      ) : (
        <Link key={s.key} to={`/setup/${s.key}`} aria-current={isActive ? "step" : undefined} className={`${cls} hover:bg-secondary-bg`}>{line}{inner}</Link>
      );
    })}
  </nav>
);

/**
 * The owner's first-run wizard (/setup, /setup/:step). Progress is saved by the server, so it resumes anywhere. Every step can be left and come back to;
 * "Finish later" returns to the app for this session. Steps after the plan wait for it only when the organisation must have a subscription first.
 */
const SetupWizard = () => {
  const { step } = useParams();
  const navigate = useNavigate();
  const { organisation } = useOrganisation();
  const { can, isLoading: permsLoading } = usePermissions();
  const query = useOnboarding({ enabled: can("organisation.manage") });
  const mutation = useOnboardingMutation();
  const saveRef = useRef(null);

  if (permsLoading || query.isLoading) return <p className="p-6 text-sm text-secondary-text">Loading…</p>;
  if (!can("organisation.manage")) return <Navigate to="/Dashboard" replace />;
  if (query.error) return <div className="p-6"><ErrorNotice error={query.error} /></div>;
  const state = query.data;
  if (state.completedAt) return <Navigate to="/Dashboard" replace />;

  if (step === "details") return <Navigate to="/setup/organisation" replace />;
  const active = SETUP_STEPS.some((s) => s.key === step) ? step : currentSetupStep(state);
  const index = setupStepIndex(active);
  const def = setupStepOf(active);
  const prev = SETUP_STEPS[index - 1];
  const next = SETUP_STEPS[index + 1];
  // Only the review waits for the plan: everything before it costs nothing, and the plan comes last because its seats follow from the team.
  const gated = state.billingRequired && state.accessState !== "open";
  const lockedFrom = gated ? setupStepIndex("review") : null;
  if (lockedFrom !== null && index >= lockedFrom) return <Navigate to="/setup/plan" replace />;

  const Page = PAGES[active];
  const markable = MARKABLE_STEPS.includes(active);
  const goNext = () => navigate(next ? `/setup/${next.key}` : "/Dashboard");
  // Optimistic: the step is marked at once and the wizard moves on; a refusal puts the mark back and the error shows on the page.
  const mark = (status) => {
    mutation.mutate({ action: "setStep", body: { step: active, status } });
    goNext();
  };
  // The organisation page saves what is typed, and marks its optional details as looked at, then moves on.
  const continueOrganisation = () => {
    if (saveRef.current?.() === false) return;
    if (pageStatus(state, "organisation").status !== "done" || state.steps.find((x) => x.key === "details")?.status === "pending") {
      mutation.mutate({ action: "setStep", body: { step: "details", status: "done" } });
    }
    goNext();
  };
  const planBlocked = active === "plan" && gated ? "Your subscription must be active before you can review and finish. Choose your seats above to start your free trial." : null;
  const doneCount = SETUP_STEPS.filter((s) => s.key !== "review" && pageStatus(state, s.key).status !== "pending").length;
  const percent = Math.round((doneCount / (SETUP_STEPS.length - 1)) * 100);

  return (
    <div className="relative flex h-dvh w-full flex-col overflow-clip bg-primary-bg">
      <header className="flex shrink-0 flex-col gap-2 border-b border-border-color px-4 pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <img src={FortressMark} alt="" className="h-9 w-9 rounded-lg" />
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold text-primary-text">Set up {organisation?.name ?? "your organisation"}</h1>
              <p className="text-xs text-secondary-text">Step {index + 1} of {SETUP_STEPS.length}. Your progress is saved: come back to any step at any time.</p>
            </div>
          </div>
          <CTAButton buttonType="button" type="neutral" size="md" onClick={() => { deferSetup(); navigate("/Dashboard"); }}>
            Finish later
          </CTAButton>
        </div>
        <div role="progressbar" aria-label="Set-up progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1 w-full overflow-hidden rounded-full bg-border-color">
          <div className="h-full rounded-full bg-brand-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[16rem_minmax(0,1fr)] lg:grid-rows-1">
        <div className="relative overflow-y-auto border-border-color p-3 lg:border-r"><Rail state={state} active={active} lockedFrom={lockedFrom} /></div>
        <div className="relative min-h-0 overflow-y-auto p-4">
          <section key={active} aria-label={def.title} className={`mx-auto flex flex-col gap-4 rounded-2xl border border-border-color bg-secondary-bg p-5 ${active === "review" || active === "team" ? "max-w-5xl" : "max-w-3xl"}`}>
            <div>
              <h2 className="text-xl font-semibold text-primary-text">{def.title}</h2>
              <p className="mt-1 text-sm text-secondary-text">{def.help}</p>
            </div>
            <Page state={state} error={mutation.error} saveRef={saveRef} />
            {active === "review" ? (
              <WizardFooter
                prev={prev}
                continueLabel="Finish set-up"
                // While a step marked a moment ago is still saving, the server has not yet said whether everything is in place: wait, don't block.
                blocked={state.canFinish || mutation.isPending ? null : "Some required steps are still open. Go back and complete them."}
                pending={mutation.isPending}
                onContinue={() => mutation.mutate({ action: "complete" }, { onSuccess: () => { resumeSetup(); navigate("/Dashboard"); } })}
              />
            ) : markable ? (
              <WizardFooter prev={prev} canSkip continueLabel="Done, continue" onSkip={() => mark("skipped")} onContinue={() => mark("done")} />
            ) : (
              <WizardFooter prev={prev} blocked={planBlocked} onContinue={active === "organisation" ? continueOrganisation : goNext} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default SetupWizard;
