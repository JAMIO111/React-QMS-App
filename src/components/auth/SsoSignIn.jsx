import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AtSignIcon } from "@/components/icons";
import { AuthCard, AuthNotice, authButtonClass, authInputClass } from "./AuthCard";
import { domainOf, startCompanySignIn } from "../../lib/sso";

/**
 * "Sign in with your company account" (docs/sso-plan.md SS2, SS11). The person types their work email; its domain decides which company's
 * sign-in they are sent to. A company can link straight here from its own portal with /sso?domain=acme.com, and Settings → Security's
 * "Test sign-in" uses /sso?provider=<id>. Fortress has no list of companies to show: Supabase answers for the domain itself.
 */
export default function SsoSignIn() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const go = async (target) => {
    setBusy(true);
    setProblem(null);
    const words = await startCompanySignIn(target);
    if (words) {
      setProblem(words);
      setBusy(false);
    }
  };

  // A link from the company's portal or from "Test sign-in" starts at once.
  useEffect(() => {
    if (started.current) return;
    const providerId = params.get("provider");
    const domain = domainOf(`x@${params.get("domain") ?? ""}`);
    if (providerId || domain) {
      started.current = true;
      go(providerId ? { providerId } : { domain });
    }
  }, [params]);

  const submit = (e) => {
    e.preventDefault();
    const domain = domainOf(email);
    if (!domain) return setProblem("Type your work email address, such as ada@acme.com.");
    go({ domain });
  };

  return (
    <AuthCard title="Sign in with your company account" subtitle="Use the same account you sign in to your work computer or email with.">
      <form noValidate onSubmit={submit} className="flex w-full flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="sso-email" className="text-left text-sm font-medium text-primary-text">
            Work email
          </label>
          <div className="relative w-full">
            <AtSignIcon className="absolute left-2 top-2 h-6 w-6 text-secondary-text" />
            <input
              id="sso-email"
              type="email"
              autoComplete="username"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`pl-10 ${authInputClass}`}
            />
          </div>
        </div>
        <button type="submit" disabled={busy} aria-busy={busy} className={authButtonClass}>
          {busy ? "Opening your company's sign-in…" : "Continue"}
        </button>
        {problem && <AuthNotice tone="error">{problem}</AuthNotice>}
        <Link to="/login" className="text-sm font-medium text-link-color hover:underline">
          Sign in with your email and password instead
        </Link>
      </form>
    </AuthCard>
  );
}
