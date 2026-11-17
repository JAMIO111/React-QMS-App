import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import CTAButton from "@/components/CTAButton";
import { BanIcon } from "@/components/icons";
import useSignOut from "../../hooks/useSignOut";
import { suspensionWords } from "../../lib/memberOnboarding";
import { WelcomeShell } from "./MemberWelcome";

/**
 * "You have been suspended from <organisation> by <person> on <date>": shown instead of "Start your organisation" to someone who has no
 * active organisation but was suspended from one. `entries` is `suspended` from /me. They can sign out, or check again (an owner or admin
 * may have reactivated them), or look for another organisation (`onElsewhere`: an invitation may be waiting); asking the people who suspended
 * them is the only way back to this one, so the page says so.
 */
export default function Suspended({ entries, onElsewhere }) {
  const queryClient = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [signOut] = useSignOut();
  const many = entries.length > 1;

  const check = async () => {
    setChecking(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["api", "me"] }),
        queryClient.invalidateQueries({ queryKey: ["memberships"] }),
      ]);
    } finally {
      setChecking(false);
    }
  };

  return (
    <WelcomeShell>
      <section aria-labelledby="suspended-title" className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-error-color/15 text-error-color" aria-hidden="true">
            <BanIcon className="h-5 w-5" />
          </span>
          <div className="flex flex-col gap-1">
            <h1 id="suspended-title" className="text-xl font-semibold text-primary-text">
              {many ? "Your access has been suspended" : `You have been suspended from ${entries[0].name}`}
            </h1>
            <p className="text-sm text-secondary-text">You cannot use {many ? "these organisations" : "this organisation"} until an owner or admin lifts the suspension.</p>
          </div>
        </div>
        <ul className="flex flex-col gap-2" aria-label="Where you are suspended">
          {entries.map((s) => (
            <li key={s.id} className="rounded-lg border border-border-color bg-primary-bg px-3 py-2 text-sm text-primary-text">
              {suspensionWords(s)}
            </li>
          ))}
        </ul>
        <p className="text-sm text-secondary-text">
          If you think this is a mistake, contact the person above or another owner or admin of {many ? "the organisation" : entries[0].name}. Your records and
          history are kept, and you will be let back in as soon as they reactivate you.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <CTAButton type="main" size="md" onClick={check} loading={checking} loadingText="Checking">
            Check again
          </CTAButton>
          <CTAButton type="neutral" size="md" onClick={() => signOut()}>
            Sign out
          </CTAButton>
          {onElsewhere && (
            <CTAButton type="secondary" size="md" onClick={onElsewhere}>
              Use a different organisation
            </CTAButton>
          )}
        </div>
      </section>
    </WelcomeShell>
  );
}
