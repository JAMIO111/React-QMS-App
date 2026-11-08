import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheckIcon } from "@/components/icons";
import { useAuth } from "../../contexts/AuthProvider";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useToast } from "../../contexts/ToastProvider";
import { describeMfaError, removeFactor, verifiedTotpFactors } from "../../lib/mfa";
import MenuCard from "../ui/MenuCard";
import LoadingButton from "../ui/LoadingButton";
import EnrolAuthenticator from "../mfa/EnrolAuthenticator";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";

/** Settings → Account: turn two-factor authentication on or off for your own account. */
const TwoFactorCard = () => {
  const { refreshAssurance } = useAuth();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [factors, setFactors] = useState(undefined);
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState(null);
  const [removing, setRemoving] = useState(false);

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
    setRemoving(true);
    try {
      for (const f of factors) await removeFactor(f.id);
      await refreshAssurance({});
      await queryClient.invalidateQueries({ queryKey: ["api"] });
      showToast({ type: "success", title: "Two-factor turned off", message: "Your authenticator app is no longer needed." });
      load();
    } catch (err) {
      showToast({ type: "error", title: "Not changed", message: describeMfaError(err) });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <MenuCard
      title="Two-factor authentication"
      titleId="two-factor-title"
      subtitle="Sign in with your password and a code from an authenticator app on your phone."
      bodyClassName="flex flex-col gap-3"
      action={
        enabled && (
          <span className="flex items-center gap-1 rounded-full bg-success-color/15 px-2 py-0.5 text-sm text-success-color">
            <ShieldCheckIcon className="h-4 w-4" /> On
          </span>
        )
      }>
      {error && (
        <p role="alert" className="text-sm text-error-color">
          {error}
        </p>
      )}
      {factors === undefined && !error && <LoadingScreen size="sm" />}
      {factors !== undefined && !enabled && !enrolling && (
        <CTAButton
          buttonType="button"
          onClick={() => setEnrolling(true)}
          type="main" size="lg" className="self-start">
          Set up two-factor
        </CTAButton>
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
        <LoadingButton
          loading={removing}
          loadingText="Turning off…"
          onClick={remove}
          variant="danger"
          size="lg"
          className="self-start">
          Turn off two-factor
        </LoadingButton>
      )}
    </MenuCard>
  );
};

export default TwoFactorCard;
