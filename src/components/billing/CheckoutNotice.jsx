import { describeApiError } from "../../lib/api-client";
import { buttonClass } from "../master-data/shared";

/** Shows how the return from Stripe Checkout went (confirming, waiting, done, cancelled...) with the way forward from each state. */
const CheckoutNotice = ({ checkout }) => {
  const { phase, error, retry, dismiss } = checkout;
  if (phase === "idle") return null;
  const wait = phase === "confirming" || phase === "waiting";
  const text = {
    confirming: "Setting up your subscription…",
    waiting: "Waiting for Stripe to confirm your payment…",
    done: "Your subscription is set up. Welcome aboard.",
    cancelled: "Checkout was cancelled and nothing was charged. Your choices are still here.",
    expired: "That checkout expired before it was finished. Choose your seats again to start a new one.",
    timeout: "Stripe has not confirmed yet. This can take a minute. Your card has not been charged twice; check again, or come back later.",
    failed: error ? describeApiError(error) : "We could not confirm the checkout.",
  }[phase];
  return (
    <div role={phase === "failed" ? "alert" : "status"} className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 text-sm ${phase === "done" ? "border-success-color text-primary-text" : phase === "failed" || phase === "timeout" || phase === "expired" ? "border-error-color text-primary-text" : "border-border-color text-primary-text"}`}>
      <span>{text}</span>
      <span className="flex gap-2">
        {(phase === "timeout" || phase === "failed") && (
          <button type="button" className={buttonClass.neutral} onClick={retry}>Check again</button>
        )}
        {!wait && (
          <button type="button" className={buttonClass.neutral} onClick={dismiss}>Dismiss</button>
        )}
      </span>
    </div>
  );
};

export default CheckoutNotice;
