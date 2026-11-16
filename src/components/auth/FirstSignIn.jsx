import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Logo from "../../assets/fortress-qms.png";
import { apiFetch, describeApiError } from "../../lib/api-client";
import { PRIVACY_URL, TERMS_URL, TERMS_VERSION } from "../../lib/terms";
import { AuthNotice, authButtonClass, authInputClass } from "./AuthCard";

const Named = ({ url, children }) =>
  url ? (
    <a href={url} target="_blank" rel="noreferrer" className="font-medium text-link-color hover:underline">
      {children}
    </a>
  ) : (
    <span className="font-medium">{children}</span>
  );

/**
 * The first time someone arrives through their company's sign-in (docs/sso-plan.md SS10) they never saw Fortress's sign-up form, so they are
 * asked once for their name (when the company did not send it) and to accept the terms. Recorded on their own profile; then Fortress opens.
 */
export default function FirstSignIn({ profile }) {
  const queryClient = useQueryClient();
  const [first, setFirst] = useState(profile?.firstName ?? "");
  const [surname, setSurname] = useState(profile?.surname ?? "");
  const [accepted, setAccepted] = useState(false);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const askName = !profile?.firstName || !profile?.surname;

  const submit = async (e) => {
    e.preventDefault();
    setProblem(null);
    if (askName && (!first.trim() || !surname.trim())) return setProblem("Type your first name and surname.");
    if (!accepted) return setProblem("Accept the terms to continue.");
    setBusy(true);
    try {
      if (askName) await apiFetch("/me", { method: "PATCH", body: { firstName: first.trim(), surname: surname.trim() } });
      await apiFetch("/me/terms", { method: "POST", body: { version: TERMS_VERSION } });
      await queryClient.invalidateQueries({ queryKey: ["api", "me"] });
    } catch (error) {
      setProblem(describeApiError(error));
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh w-full items-start justify-center overflow-y-auto bg-primary-bg p-4 sm:items-center">
      <form noValidate onSubmit={submit} className="flex w-full max-w-md flex-col gap-5 rounded-2xl bg-secondary-bg p-6 shadow-sm">
        <img src={Logo} alt="Fortress QMS" className="h-10 w-10 rounded-lg" />
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-primary-text">Welcome to Fortress QMS</h1>
          <p className="text-sm text-secondary-text">You signed in with your company account{profile?.email ? ` (${profile.email})` : ""}. One step before you start.</p>
        </div>
        {askName && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-medium text-primary-text" data-required>
              First name
              <input value={first} onChange={(e) => setFirst(e.target.value)} autoComplete="given-name" className={authInputClass} aria-required="true" />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-primary-text" data-required>
              Surname
              <input value={surname} onChange={(e) => setSurname(e.target.value)} autoComplete="family-name" className={authInputClass} aria-required="true" />
            </label>
          </div>
        )}
        <label className="flex items-start gap-2 text-sm text-primary-text">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5 h-4 w-4" />
          <span>
            I accept Fortress QMS&apos;s <Named url={TERMS_URL}>terms of service</Named> and have read the <Named url={PRIVACY_URL}>privacy notice</Named>.
          </span>
        </label>
        {problem && <AuthNotice tone="error">{problem}</AuthNotice>}
        <button type="submit" disabled={busy} aria-busy={busy} className={authButtonClass}>
          {busy ? "Saving…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
