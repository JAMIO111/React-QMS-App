import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheckIcon } from "@/components/icons";
import { useAuth } from "../../contexts/AuthProvider";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useToast } from "../../contexts/ToastProvider";
import { describeMfaError, removeFactor, verifiedTotpFactors } from "../../lib/mfa";
import EnrolAuthenticator from "../mfa/EnrolAuthenticator";

/** Settings → Account: turn two-factor authentication on or off for your own account. */
const TwoFactorCard = () => {
  const { refreshAssurance } = useAuth();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [factors, setFactors] = useState(undefined);
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    verifiedTotpFactors()
      .then(setFactors)
      .catch((err) => setError(describeMfaError(err)));
  }, []);
  useEffect(load, [load]);

  const enabled = factors?.length > 0;

  const remove = async () => {
    const ok = await confirm({
      title: "Turn off two-factor authentication?",
      message:
        "Your account will be protected by your password only. Organisations that require two-factor will ask you to set it up again.",
      confirmText: "Turn off",
      cancelText: "Cancel",
      type: "warning",
    });
    if (!ok) return;
    try {
      for (const f of factors) await removeFactor(f.id);
      await refreshAssurance({});
      await queryClient.invalidateQueries({ queryKey: ["api"] });
      showToast({ type: "success", title: "Two-factor turned off", message: "Your authenticator app is no longer needed." });
      load();
    } catch (err) {
      showToast({ type: "error", title: "Not changed", message: describeMfaError(err) });
    }
  };

  return (
    <section aria-labelledby="two-factor-title" className="flex flex-col gap-3 bg-secondary-bg rounded-3xl border border-border-color p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="two-factor-title" className="text-primary-text text-xl">
          Two-factor authentication
        </h2>
        {enabled && (
          <span className="flex items-center gap-1 rounded-full bg-success-color/15 px-2 py-0.5 text-sm text-success-color">
            <ShieldCheckIcon className="h-4 w-4" /> On
          </span>
        )}
      </div>
      <p className="text-secondary-text text-sm">
        Sign in with your password and a code from an authenticator app on your phone.
      </p>
      {error && (
        <p role="alert" className="text-sm text-error-color">
          {error}
        </p>
      )}
      {factors === undefined && !error && <p className="text-secondary-text text-sm">Loading…</p>}
      {factors !== undefined && !enabled && !enrolling && (
        <button
          type="button"
          onClick={() => setEnrolling(true)}
          className="self-start rounded-lg border border-cta-btn-border bg-cta-btn-bg px-4 py-2 text-primary-text hover:bg-cta-btn-bg-hover cursor-pointer">
          Set up two-factor
        </button>
      )}
      {enrolling && (
        <EnrolAuthenticator
          onCancel={() => setEnrolling(false)}
          onDone={async () => {
            setEnrolling(false);
            await refreshAssurance({});
            await queryClient.invalidateQueries({ queryKey: ["api"] });
            showToast({ type: "success", title: "Two-factor is on", message: "You'll be asked for a code when you sign in." });
            load();
          }}
        />
      )}
      {enabled && (
        <button
          type="button"
          onClick={remove}
          className="self-start rounded-lg border border-error-btn-border bg-error-btn-bg px-4 py-2 text-primary-text hover:bg-error-btn-bg-hover cursor-pointer">
          Turn off two-factor
        </button>
      )}
    </section>
  );
};

export default TwoFactorCard;
