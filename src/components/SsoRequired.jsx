import { useState } from "react";
import { Link } from "react-router-dom";
import CTAButton from "@/components/CTAButton";
import Callout from "./ui/Callout";
import { ShieldAlertIcon } from "@/components/icons";
import { startCompanySignIn } from "../lib/sso";
import useSignOut from "../hooks/useSignOut";

/**
 * Shown instead of the app when an organisation requires its company sign-in and this session did not use it (docs/sso-plan.md SS6). It shows
 * nothing of the organisation's data: its name, a button to sign in with the company account, and, for a break-glass member, the way in with
 * a password and two-factor instead. `organisations` = [{ id, name, providerId, breakGlass }] (from /me, or from a 403 sso_required).
 */
export default function SsoRequired({ organisations, fullPage = false }) {
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(null);
  const [signOut] = useSignOut();
  const signIn = async (o) => {
    setProblem(null);
    setBusy(o.id);
    const failed = await startCompanySignIn({ providerId: o.providerId });
    if (failed) {
      setProblem(failed);
      setBusy(null);
    }
  };
  const names = organisations.map((o) => o.name).filter(Boolean);
  const title = `${names.length === 1 ? names[0] : names.length ? names.join(" and ") : "This organisation"} ${names.length > 1 ? "require" : "requires"} your company sign-in`;

  return (
    <div
      className={`flex flex-1 items-center justify-center overflow-y-auto bg-primary-bg p-4 ${fullPage ? "min-h-dvh" : ""}`}
      role="alert"
      aria-labelledby="sso-required-title">
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-2xl border border-border-color bg-secondary-bg p-6 shadow-sm">
        <ShieldAlertIcon className="text-4xl text-warning-color" aria-hidden />
        <h1 id="sso-required-title" className="text-xl font-semibold text-primary-text">
          {title}
        </h1>
        <p className="text-sm text-secondary-text">
          You signed in with an email and password. Sign in with your company account (the one you use for email and other work systems) to carry on.
        </p>
        {problem && <Callout tone="error" role="alert">{problem}</Callout>}
        <div className="flex flex-col gap-3">
          {organisations.map((o) => (
            <div key={o.id} className="flex flex-wrap items-center gap-2">
              {o.providerId ? (
                <CTAButton type="main" size="md" onClick={() => signIn(o)} loading={busy === o.id} loadingText="Opening your company sign-in">
                  {organisations.length > 1 ? `Sign in to ${o.name} with your company account` : "Sign in with your company account"}
                </CTAButton>
              ) : (
                <p className="text-sm text-secondary-text">{o.name}&apos;s company sign-in is not connected. Ask an administrator.</p>
              )}
              {o.breakGlass && (
                <CTAButton type="secondary" size="md" to="/mfa?next=%2F">
                  Use two-factor instead
                </CTAButton>
              )}
            </div>
          ))}
        </div>
        {organisations.some((o) => o.breakGlass) && (
          <p className="text-xs text-secondary-text">
            You are a break-glass member: if the company sign-in is not working, you can get in with your password and two-factor. Owners and admins are
            told when you do.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button type="button" className="cursor-pointer font-medium text-link-color hover:underline" onClick={() => signOut()}>
            Sign out
          </button>
          <Link to="/sso" className="font-medium text-link-color hover:underline">
            Sign in with your work email instead
          </Link>
        </div>
      </div>
    </div>
  );
}
