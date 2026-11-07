import { useNavigate, useParams, Link, Navigate } from "react-router-dom";
import { CheckIcon, LockIcon } from "@/components/icons";
import FortressMark from "../../assets/fortress-qms.png";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useOnboarding, useOnboardingMutation } from "../../hooks/useOnboarding";
import { MARKABLE_STEPS, SETUP_STEPS, deferSetup, resumeSetup, setupStepIndex, setupStepOf } from "../../lib/onboarding";
import { ErrorNotice, buttonClass } from "../master-data/shared";
import WizardFooter from "./WizardFooter";
import { DetailsStep, OrganisationStep, PlanStep, ReviewStep, SecurityStep, SitesStep, TeamStep } from "./steps";

const PAGES = { organisation: OrganisationStep, plan: PlanStep, details: DetailsStep, sites: SitesStep, security: SecurityStep, team: TeamStep, review: ReviewStep };

const Rail = ({ state, active, lockedFrom }) => (
  <nav aria-label="Set-up steps" className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
    {SETUP_STEPS.map((s, i) => {
      const st = state.steps.find((x) => x.key === s.key);
      const locked = lockedFrom !== null && i >= lockedFrom;
      const isActive = s.key === active;
      const inner = (
        <>
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${st.status === "done" ? "bg-success-color text-white" : isActive ? "border-2 border-brand-primary text-primary-text" : "border border-border-color text-secondary-text"}`}>
            {st.status === "done" ? <CheckIcon className="h-4 w-4" aria-label="Done" /> : locked ? <LockIcon className="h-3.5 w-3.5" aria-label="Locked" /> : i + 1}
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate">{s.label}</span>
            <span className="text-xs text-secondary-text">{st.status === "skipped" ? "Skipped" : st.required ? "Required" : "Optional"}</span>
          </span>
        </>
      );
      const cls = `flex min-w-[9rem] items-center gap-3 rounded-xl border px-3 py-2 text-sm lg:min-w-0 ${isActive ? "border-brand-primary bg-brand-primary/10 text-primary-text" : "border-transparent text-secondary-text"}`;
      return locked ? (
        <span key={s.key} aria-disabled="true" title="Available once your plan is active" className={`${cls} opacity-60`}>{inner}</span>
      ) : (
        <Link key={s.key} to={`/setup/${s.key}`} aria-current={isActive ? "step" : undefined} className={`${cls} hover:bg-secondary-bg`}>{inner}</Link>
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

  if (permsLoading || query.isLoading) return <p className="p-6 text-sm text-secondary-text">Loading…</p>;
  if (!can("organisation.manage")) return <Navigate to="/Dashboard" replace />;
  if (query.error) return <div className="p-6"><ErrorNotice error={query.error} /></div>;
  const state = query.data;
  if (state.completedAt) return <Navigate to="/Dashboard" replace />;

  const active = SETUP_STEPS.some((s) => s.key === step) ? step : state.currentStep;
  const index = setupStepIndex(active);
  const def = setupStepOf(active);
  const prev = SETUP_STEPS[index - 1];
  const next = SETUP_STEPS[index + 1];
  const planIndex = setupStepIndex("plan");
  const gated = state.billingRequired && state.accessState !== "open";
  const lockedFrom = gated ? planIndex + 1 : null;
  if (lockedFrom !== null && index >= lockedFrom) return <Navigate to="/setup/plan" replace />;

  const Page = PAGES[active];
  const markable = MARKABLE_STEPS.includes(active);
  const goNext = () => navigate(next ? `/setup/${next.key}` : "/Dashboard");
  const mark = (status) => mutation.mutate({ action: "setStep", body: { step: active, status } }, { onSuccess: goNext });
  const planBlocked = active === "plan" && gated ? "Your subscription must be active before you can continue. Open Subscription & billing to set it up." : null;
  const labelOf = (key) => SETUP_STEPS.find((s) => s.key === key)?.label ?? key;

  return (
    <div className="flex h-dvh w-full flex-col overflow-clip bg-primary-bg">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border-color px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <img src={FortressMark} alt="" className="h-9 w-9 rounded-lg" />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-primary-text">Set up {organisation?.name ?? "your organisation"}</h1>
            <p className="text-xs text-secondary-text">Your progress is saved. Come back to any step at any time.</p>
          </div>
        </div>
        <button type="button" className={buttonClass.neutral} onClick={() => { deferSetup(); navigate("/Dashboard"); }}>
          Finish later
        </button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[16rem_minmax(0,1fr)] lg:grid-rows-1">
        <div className="overflow-y-auto border-border-color p-3 lg:border-r"><Rail state={state} active={active} lockedFrom={lockedFrom} /></div>
        <div className="min-h-0 overflow-y-auto p-4">
          <section aria-label={def.title} className="mx-auto flex max-w-3xl flex-col gap-4 rounded-2xl border border-border-color bg-secondary-bg p-5">
            <div>
              <h2 className="text-xl font-semibold text-primary-text">{def.title}</h2>
              <p className="mt-1 text-sm text-secondary-text">{def.help}</p>
            </div>
            <Page state={state} labelOf={labelOf} error={mutation.error} />
            {active === "review" ? (
              <WizardFooter
                prev={prev}
                continueLabel="Finish set-up"
                blocked={state.canFinish ? null : "Some required steps are still open. Go back and complete them."}
                pending={mutation.isPending}
                onContinue={() => mutation.mutate({ action: "complete" }, { onSuccess: () => { resumeSetup(); navigate("/Dashboard"); } })}
              />
            ) : markable ? (
              <WizardFooter prev={prev} canSkip pending={mutation.isPending} continueLabel="Done, continue" onSkip={() => mark("skipped")} onContinue={() => mark("done")} />
            ) : (
              <WizardFooter prev={prev} blocked={planBlocked} onContinue={goNext} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default SetupWizard;
