import MenuCard from "../ui/MenuCard";
import CTAButton from "@/components/CTAButton";
import { useSsoMatches, useSsoMatchMutation } from "../../hooks/useSecurity";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { whenWords } from "../../lib/security";

/**
 * Settings → Users & permissions: members who signed in with their company account as well as their password account (docs/sso-plan.md SS5).
 * Moving brings the membership, roles, seat and open work across; finished records stay with the old account as history. Only for people who
 * manage members, and only when there is something to move.
 */
export default function SsoMatches() {
  const matches = useSsoMatches();
  const mutation = useSsoMatchMutation();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const list = matches.data?.data ?? [];
  if (!list.length) return null;

  const move = async (m) => {
    const ok = await confirm({
      title: `Move ${m.name ?? m.email} to their company account?`,
      message:
        "Their membership, roles, departments, seat and open work (actions, tasks, sign-offs, documents to read, things they own) move to the account they sign in to with their company. Finished records keep the old account. This cannot be undone here.",
      confirmText: "Move",
      cancelText: "Cancel",
      type: "warning",
    });
    if (!ok) return;
    mutation.mutate(
      { action: "move", match: m },
      {
        onSuccess: (res) => {
          const skipped = Object.keys(res?.skipped ?? {}).length;
          showToast({
            type: skipped ? "warning" : "success",
            title: "Moved",
            message: skipped
              ? `${m.name ?? m.email} now signs in with their company account. ${skipped} kind${skipped === 1 ? "" : "s"} of record stayed where their own rules refused the change.`
              : `${m.name ?? m.email} now signs in with their company account.`,
          });
        },
        onError: (error) => showToast({ type: "error", title: "Not moved", message: describeApiError(error) }),
      },
    );
  };
  const dismiss = (m) =>
    mutation.mutate({ action: "dismiss", match: m }, { onError: (error) => showToast({ type: "error", title: "Not changed", message: describeApiError(error) }) });

  return (
    <MenuCard
      aria-label="Accounts to move across"
      title="Accounts to move to company sign-in"
      subtitle="These members also signed in with their company account, at the same address. Move them so their work follows them."
      bodyClassName="flex flex-col gap-3">
      <ul className="flex flex-col gap-2" aria-label="Accounts to move">
        {list.map((m) => (
          <li key={`${m.passwordUserId}-${m.ssoUserId}`} className="flex flex-wrap items-center gap-3 rounded-xl border border-border-color p-3" aria-label={m.email}>
            <div className="flex min-w-48 flex-1 flex-col">
              <span className="font-medium text-primary-text">{m.name ?? m.email}</span>
              <span className="text-xs text-secondary-text">
                {m.email} · company account made {whenWords(m.ssoCreatedAt)}
                {m.ssoLastSignInAt ? `, last signed in ${whenWords(m.ssoLastSignInAt)}` : ""}
              </span>
            </div>
            <CTAButton type="main" size="default" onClick={() => move(m)}>
              Move
            </CTAButton>
            <CTAButton type="neutral" size="default" onClick={() => dismiss(m)}>
              Not the same person
            </CTAButton>
          </li>
        ))}
      </ul>
    </MenuCard>
  );
}
