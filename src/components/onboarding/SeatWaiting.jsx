import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";
import { HourglassIcon } from "@/components/icons";
import { apiFetch, describeApiError } from "../../lib/api-client";
import { managersWords, nextReminderAt } from "../../lib/memberOnboarding";
import { useMe } from "../../hooks/useQmsApi";
import useSignOut from "../../hooks/useSignOut";

const when = (d) => new Date(d).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Waiting for a seat (docs/seats-and-member-onboarding-plan.md SM4): the person has joined but an owner or admin must give them a seat before
 * they can use Fortress. Says who can, when they were told, lets the person remind them once a day, and checks every 30 seconds so they are let in
 * as soon as a seat is given. `wait` is the entry from /me (seats.waitingIn).
 */
export default function SeatWaiting({ wait }) {
  const queryClient = useQueryClient();
  // poll: the screen goes away once /me no longer lists the organisation
  useMe({ refetchInterval: 30_000 });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [sent, setSent] = useState(false);
  const [signOut] = useSignOut();
  const who = managersWords(wait.managers);
  const again = nextReminderAt(wait.lastToldAt);

  const remind = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await apiFetch("/me/seat-reminder", { method: "POST", body: { organisationId: wait.id } });
      setSent(true);
      await queryClient.invalidateQueries({ queryKey: ["api", "me"] });
    } catch (error) {
      setProblem(describeApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="seat-waiting-title" className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning-color/15 text-warning-color" aria-hidden="true">
          <HourglassIcon className="h-5 w-5" />
        </span>
        <div className="flex flex-col gap-1">
          <h1 id="seat-waiting-title" className="text-xl font-semibold text-primary-text">
            You need a seat in {wait.name}
          </h1>
          <p className="text-sm text-secondary-text">
            You have joined, but an owner or admin needs to give you a seat before you can start. {who ? `${who} can give you one.` : ""}
          </p>
        </div>
      </div>
      <p className="text-sm text-primary-text" role="status">
        {wait.lastToldAt ? `They were told on ${when(wait.lastToldAt)}.` : "They have not been told yet."} This page lets you in as soon as you have a seat.
      </p>
      {sent && <Callout tone="success">We have reminded them.</Callout>}
      {problem && <Callout tone="error" role="alert">{problem}</Callout>}
      <div className="flex flex-wrap items-center gap-2">
        <CTAButton type="main" size="md" onClick={remind} loading={busy} loadingText="Reminding" disabled={!!again || sent}>
          Remind them
        </CTAButton>
        <CTAButton type="neutral" size="md" onClick={() => signOut()}>
          Sign out
        </CTAButton>
        {again && !sent && <span className="text-xs text-secondary-text">You can remind them again from {when(again)}.</span>}
      </div>
    </section>
  );
}
