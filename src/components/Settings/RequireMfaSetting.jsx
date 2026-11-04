import { Link } from "react-router-dom";
import { useAuth } from "../../contexts/AuthProvider";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useToast } from "../../contexts/ToastProvider";
import { useUpdateOrganisation } from "../../hooks/useQmsApi";
import MenuCard from "../ui/MenuCard";
import { describeApiError } from "../../lib/api-client";

/** Settings → Organisation: require every member to use two-factor authentication. */
const RequireMfaSetting = ({ value, canManage }) => {
  const { assurance } = useAuth();
  const update = useUpdateOrganisation();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const sessionPassedMfa = assurance?.currentLevel === "aal2";
  // Turning it on needs your own two-factor first (otherwise you would lock yourself out).
  const blockedOn = !value && !sessionPassedMfa;
  const disabled = !canManage || blockedOn || update.isPending;

  const toggle = async () => {
    const next = !value;
    if (next) {
      const ok = await confirm({
        title: "Require two-factor authentication?",
        message:
          "Members without two-factor will be asked to set it up at their next visit and can't see this organisation's data until they do.",
        confirmText: "Require it",
        cancelText: "Cancel",
        type: "warning",
      });
      if (!ok) return;
    }
    update.mutate(
      { body: { settings: { requireMfa: next } }, reason: next ? "Two-factor authentication required" : "Two-factor requirement removed" },
      {
        onSuccess: () =>
          showToast({ type: "success", title: "Saved", message: next ? "Two-factor is now required." : "Two-factor is no longer required." }),
        onError: (error) => showToast({ type: "error", title: "Not changed", message: describeApiError(error) }),
      }
    );
  };

  return (
    <MenuCard
      title="Require two-factor authentication"
      titleId="require-mfa-title"
      subtitle="Every member must sign in with a code from an authenticator app."
      bodyClassName="flex flex-col gap-2"
      action={
        <button
          type="button"
          role="switch"
          aria-checked={value}
          aria-labelledby="require-mfa-title"
          disabled={disabled}
          onClick={toggle}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${value ? "bg-brand-primary" : "bg-border-dark-color"} ${
            disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
          }`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${value ? "left-5.5" : "left-0.5"}`} />
        </button>
      }>
      {canManage && blockedOn && (
        <p className="text-sm text-secondary-text">
          Turn on two-factor for your own account first in{" "}
          <Link to="/Settings/Account" className="text-link-color hover:underline">
            Settings → Account
          </Link>
          .
        </p>
      )}
    </MenuCard>
  );
};

export default RequireMfaSetting;
