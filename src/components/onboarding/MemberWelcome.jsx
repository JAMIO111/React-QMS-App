import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import FortressMark from "../../assets/fortress-qms.png";
import CTAButton from "@/components/CTAButton";
import Field from "../ui/Field";
import Callout from "../ui/Callout";
import { BellIcon, CheckIcon, MailIcon } from "@/components/icons";
import { apiFetch, describeApiError } from "../../lib/api-client";
import { WELCOME_STEPS, firstOpenStep } from "../../lib/memberOnboarding";
import { useMe } from "../../hooks/useQmsApi";
import SeatWaiting from "./SeatWaiting";

/** The page around member onboarding and the waiting screen: Fortress's own, not the organisation's. */
export const WelcomeShell = ({ children }) => (
  <main className="h-dvh w-full overflow-y-auto bg-primary-bg">
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="flex w-full max-w-xl flex-col gap-5 rounded-2xl border border-border-color bg-secondary-bg p-6 text-primary-text">
        <div className="flex items-center gap-3">
          <img src={FortressMark} alt="" className="h-9 w-9 rounded-lg" />
          <span className="text-lg font-semibold">Fortress QMS</span>
        </div>
        {children}
      </div>
    </div>
  </main>
);

const StepRail = ({ current }) => (
  <ol className="flex flex-wrap gap-2 text-sm" aria-label="Your set-up">
    {WELCOME_STEPS.map((s, i) => {
      const at = WELCOME_STEPS.findIndex((x) => x.key === current);
      const done = i < at;
      return (
        <li
          key={s.key}
          aria-current={s.key === current ? "step" : undefined}
          className={`flex items-center gap-1.5 rounded-full border px-3 py-1 ${s.key === current ? "border-brand-primary text-primary-text" : "border-border-color text-secondary-text"}`}>
          {done ? <CheckIcon className="text-success-color" aria-label="done" /> : <span aria-hidden="true">{i + 1}</span>}
          {s.label}
        </li>
      );
    })}
  </ol>
);

/**
 * A member's own set-up (docs/seats-and-member-onboarding-plan.md SM6), after accepting an invitation or joining with their company account: about
 * you (name, job title), how Fortress reaches them, then ready — or, without a seat, the waiting screen (SM4). Not the organisation's set-up,
 * which is the founder's wizard. `welcome` is the entry from /me (welcome[]), `wait` the matching seats.waitingIn entry when they have no seat.
 */
export default function MemberWelcome({ welcome, wait }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const profile = me.data?.profile ?? {};
  const [step, setStep] = useState(() => firstOpenStep(welcome));
  const [first, setFirst] = useState(profile.firstName ?? "");
  const [surname, setSurname] = useState(profile.surname ?? "");
  const [jobTitle, setJobTitle] = useState(profile.jobTitle ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  const mark = (s) => apiFetch("/me/welcome", { method: "POST", body: { organisationId: welcome.id, step: s } });
  const run = async (fn) => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
    } catch (error) {
      setProblem(describeApiError(error));
    } finally {
      setBusy(false);
    }
  };

  const saveAbout = (e) => {
    e.preventDefault();
    if (!first.trim() || !surname.trim()) return setProblem("Type your first name and surname.");
    run(async () => {
      await apiFetch("/me", { method: "PATCH", body: { firstName: first.trim(), surname: surname.trim(), jobTitle: jobTitle.trim() || null } });
      await mark("about");
      setStep("notifications");
    });
  };
  const saveNotifications = () =>
    run(async () => {
      await mark("notifications");
      setStep("done");
    });
  const finish = () =>
    run(async () => {
      await mark("done");
      await queryClient.invalidateQueries({ queryKey: ["api", "me"] });
      navigate("/", { replace: true });
    });

  return (
    <WelcomeShell>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Welcome to {welcome.name}</h1>
        <p className="text-sm text-secondary-text">A few things about you before you start. Your organisation is already set up.</p>
      </div>
      <StepRail current={step} />
      {problem && <Callout tone="error" role="alert">{problem}</Callout>}

      {step === "about" && (
        <form noValidate onSubmit={saveAbout} className="flex flex-col gap-3" aria-label="About you">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First name" required value={first} onChange={(e) => setFirst(e.target.value)} autoComplete="given-name" />
            <Field label="Surname" required value={surname} onChange={(e) => setSurname(e.target.value)} autoComplete="family-name" />
          </div>
          <Field label="Job title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="Quality inspector" autoComplete="organization-title" />
          <p className="text-xs text-secondary-text">Your colleagues see your name on everything you record. You can add a profile picture later in Settings → Account.</p>
          <CTAButton type="main" size="lg" buttonType="submit" className="self-start" loading={busy} loadingText="Saving">
            Continue
          </CTAButton>
        </form>
      )}

      {step === "notifications" && (
        <section className="flex flex-col gap-3" aria-label="How we reach you">
          <ul className="flex flex-col gap-3 text-sm">
            <li className="flex gap-3">
              <BellIcon className="mt-0.5 h-5 w-5 shrink-0 text-brand-primary" aria-hidden="true" />
              <span>The bell at the top of every page shows what happened in the parts of Fortress you work in. Your own changes never notify you.</span>
            </li>
            <li className="flex gap-3">
              <MailIcon className="mt-0.5 h-5 w-5 shrink-0 text-brand-primary" aria-hidden="true" />
              <span>Things addressed to you — an action given to you, a document to read, a daily reminder of what is due — are emailed too.</span>
            </li>
          </ul>
          <p className="text-xs text-secondary-text">You can switch any of these on or off in Settings → Notifications.</p>
          <CTAButton type="main" size="lg" className="self-start" onClick={saveNotifications} loading={busy} loadingText="Saving">
            Continue
          </CTAButton>
        </section>
      )}

      {step === "done" &&
        (wait ? (
          <SeatWaiting wait={wait} />
        ) : (
          <section className="flex flex-col gap-3" aria-label="Ready">
            <p className="text-sm">You are all set. Your role decides what you can do; an administrator can change it.</p>
            <CTAButton type="main" size="lg" className="self-start" onClick={finish} loading={busy} loadingText="Opening Fortress">
              Go to Fortress
            </CTAButton>
          </section>
        ))}
    </WelcomeShell>
  );
}
