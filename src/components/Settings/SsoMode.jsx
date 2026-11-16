import { useState } from "react";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import Switch from "../ui/Switch";
import SlidingToggle from "../ui/SlidingToggle";
import ComboField from "../ui/ComboField";
import CTAButton from "@/components/CTAButton";
import { XIcon } from "@/components/icons";
import { useSsoMutation } from "../../hooks/useSecurity";
import { useAllDepartments } from "../../hooks/useQmsApi";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { SSO_MODES, whenWords } from "../../lib/security";

const personWords = (p) => p.name || p.email || "Someone";

/**
 * The second half of the Single sign-on card (docs/sso-plan.md SS6–SS9): Off / Optional / Required, whether a company sign-in meets the
 * two-factor rule, the break-glass members, recent company sign-ins and the history of changes. Requiring it asks for confirmation, says who
 * will be blocked, and is only possible from a session that came through the company sign-in (the server checks that too).
 */
export default function SsoMode({ sso, canManage }) {
  const mutate = useSsoMutation();
  const { showToast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const connected = !!sso.provider && sso.provider.domains.length > 0;
  const fail = (title) => (error) => showToast({ type: "error", title, message: describeApiError(error) });

  const choose = (mode) => {
    if (mode === sso.mode) return;
    if (mode === "required") return setConfirming(true);
    mutate.mutate({ action: "setMode", body: { mode } }, { onError: fail("Not changed") });
  };

  return (
    <section className="flex flex-col gap-4 border-t border-border-color pt-4" aria-label="Using single sign-on">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-primary-text">Using single sign-on</h3>
        <p className="text-sm text-secondary-text">{SSO_MODES[sso.mode]?.note}</p>
      </div>
      <SlidingToggle
        ariaLabel="Single sign-on"
        mode="radio"
        options={Object.entries(SSO_MODES).map(([value, m]) => ({ value, label: m.label, disabled: !canManage || (value !== "off" && !connected) }))}
        value={sso.mode}
        onChange={choose}
      />
      {!connected && sso.mode === "off" && <p className="text-xs text-secondary-text">Connect your company&apos;s sign-in above to offer or require it.</p>}
      {sso.modeChangedAt && (
        <p className="text-xs text-secondary-text">
          Changed {whenWords(sso.modeChangedAt)}
          {sso.modeChangedBy ? ` by ${sso.modeChangedBy}` : ""}.
        </p>
      )}
      {sso.mode === "required" && (
        <Callout tone="info" title="Sessions">
          {sso.sessionHours.stored
            ? `People sign in again every ${sso.sessionHours.stored} hours (set below under Sign in again after).`
            : "People sign in again every 12 hours, so someone who leaves your company cannot keep a session open. Set another limit below under Sign in again after."}
        </Callout>
      )}

      <Switch
        checked={sso.trustIdpMfa}
        disabled={!canManage}
        onChange={(e) => mutate.mutate({ action: "setTrust", body: { trust: e.target.checked } }, { onError: fail("Not changed") })}>
        A company sign-in meets the two-factor rule
      </Switch>
      <p className="-mt-2 text-xs text-secondary-text">
        {sso.trustIdpMfa
          ? "Your company's own sign-in checks the second factor, so people are not asked again here."
          : "People who sign in with their company account also need Fortress two-factor while the organisation requires it."}
      </p>

      <Joining sso={sso} canManage={canManage} mutate={mutate} fail={fail} />
      <BreakGlass sso={sso} canManage={canManage} mutate={mutate} fail={fail} />
      <SignIns sso={sso} />
      <Moves sso={sso} />
      <Changes sso={sso} />

      {confirming && <RequireDialog sso={sso} onClose={() => setConfirming(false)} mutate={mutate} showToast={showToast} />}
    </section>
  );
}

function Joining({ sso, canManage, mutate, fail }) {
  const departments = useAllDepartments();
  const joining = sso.joining ?? { roleId: null, departmentId: null, roleOptions: [] };
  const viewer = joining.roleOptions.find((r) => r.key === "viewer") ?? joining.roleOptions[0];
  const save = (body) => mutate.mutate({ action: "setJoining", body }, { onError: fail("Not changed") });
  const deptOptions = (departments.data?.data ?? []).filter((d) => d.active !== false);
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold text-primary-text">Who can join</h4>
      <SlidingToggle
        ariaLabel="Who can join"
        mode="radio"
        options={[
          { value: "invited", label: "Invited people only", disabled: !canManage },
          { value: "domain", label: "Anyone at your domains", disabled: !canManage || !viewer },
        ]}
        value={sso.join}
        onChange={(join) => save(join === "domain" ? { join, roleId: joining.roleId ?? viewer?.id, departmentId: joining.departmentId } : { join })}
      />
      <p className="text-xs text-secondary-text">
        {sso.join === "domain"
          ? "Anyone who signs in with their company account at your verified domains joins straight away, with no seat. Owners and admins are told of each one."
          : "People sign in with their company account once they have been invited."}
      </p>
      {sso.join === "domain" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <ComboField
            label="They start as"
            required
            value={joining.roleId}
            disabled={!canManage}
            options={joining.roleOptions.map((r) => ({ value: r.id, label: r.name }))}
            onChange={(roleId) => roleId && save({ join: "domain", roleId, departmentId: joining.departmentId })}
          />
          <ComboField
            label="In the department"
            value={joining.departmentId}
            disabled={!canManage}
            placeholder="No department"
            options={deptOptions.map((d) => ({ value: d.id, label: d.name, hint: d.siteCode ?? d.site?.code ?? undefined }))}
            onChange={(departmentId) => save({ join: "domain", roleId: joining.roleId, departmentId })}
          />
        </div>
      )}
    </div>
  );
}

function Moves({ sso }) {
  const moves = sso.moves ?? [];
  if (!moves.length) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-secondary-text">Accounts moved to company sign-in ({moves.length})</summary>
      <ul className="mt-2 flex flex-col gap-1" aria-label="Accounts moved">
        {moves.map((m) => {
          const count = Object.values(m.moved ?? {}).reduce((a, b) => a + Number(b), 0);
          const skipped = Object.keys(m.skipped ?? {}).length;
          return (
            <li key={m.id} className="text-secondary-text">
              {whenWords(m.at)}: <span className="text-primary-text">{m.name ?? m.email}</span>
              {m.bySelf ? " (confirmed with their old password)" : ""} — {count} open {count === 1 ? "item" : "items"} moved
              {skipped ? `, ${skipped} ${skipped === 1 ? "kind" : "kinds"} left where their own rules refused it` : ""}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function BreakGlass({ sso, canManage, mutate, fail }) {
  const chosen = sso.breakGlass.map((b) => b.userId);
  const candidates = sso.passwordMembers.filter((m) => m.ownerOrAdmin && !chosen.includes(m.userId));
  const save = (userIds) => mutate.mutate({ action: "setBreakGlass", body: { userIds } }, { onError: fail("Break-glass members not saved") });
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold text-primary-text">Break-glass members</h4>
      <p className="text-sm text-secondary-text">
        Up to three owners or admins who may still sign in with their password <strong>and</strong> two-factor while single sign-on is required, in
        case the company sign-in stops working. Every time one does, owners and admins are told.
      </p>
      {sso.breakGlass.length === 0 ? (
        <p className="text-sm text-secondary-text">Nobody yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label="Break-glass members">
          {sso.breakGlass.map((b) => (
            <li key={b.userId} className="inline-flex items-center gap-1 rounded-full bg-secondary-bg px-3 py-1 text-sm text-primary-text">
              {personWords(b)}
              {canManage && (
                <button
                  type="button"
                  className="cursor-pointer rounded-full p-0.5 text-secondary-text hover:text-primary-text"
                  aria-label={`Take ${personWords(b)} off the list`}
                  onClick={() => save(chosen.filter((id) => id !== b.userId))}>
                  <XIcon aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && chosen.length < 3 && (
        <ComboField
          label="Add a break-glass member"
          value={null}
          options={candidates.map((m) => ({ value: m.userId, label: personWords(m), hint: m.email ?? undefined }))}
          placeholder={candidates.length ? "Choose an owner or admin" : "No other owner or admin signs in with a password"}
          disabled={!candidates.length}
          onChange={(id) => id && save([...chosen, id])}
          className="max-w-sm"
        />
      )}
    </div>
  );
}

function SignIns({ sso }) {
  if (!sso.signIns.length) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-secondary-text">Company and break-glass sign-ins in the last 30 days ({sso.signIns.length})</summary>
      <ul className="mt-2 flex flex-col gap-1" aria-label="Recent sign-ins">
        {sso.signIns.map((i) => (
          <li key={`${i.userId}-${i.method}`} className="text-secondary-text">
            <span className="text-primary-text">{i.name ?? "Someone"}</span> — {i.method === "break_glass" ? "break-glass (password and two-factor)" : "company sign-in"}, last{" "}
            {whenWords(i.lastAt)}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Changes({ sso }) {
  if (!sso.changes.length) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-secondary-text">History of changes ({sso.changes.length})</summary>
      <ul className="mt-2 flex flex-col gap-1" aria-label="Single sign-on changes">
        {sso.changes.map((c) => (
          <li key={c.id} className="text-secondary-text">
            {whenWords(c.at)}: {c.summary}
          </li>
        ))}
      </ul>
    </details>
  );
}

function RequireDialog({ sso, onClose, mutate, showToast }) {
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState(null);
  const blocked = sso.passwordMembers.filter((m) => !m.breakGlass);
  const submit = (e) => {
    e.preventDefault();
    setProblem(null);
    if (typed.trim().toLowerCase() !== "require") return setProblem('Type "require" to confirm.');
    mutate.mutate(
      { action: "setMode", body: { mode: "required", confirm: true } },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Single sign-on required", message: "Members now sign in with their company account." });
          onClose();
        },
        onError: (error) => setProblem(describeApiError(error)),
      },
    );
  };
  return (
    <Dialog title="Require single sign-on?" onClose={onClose}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        {!sso.session.viaSso ? (
          <Callout
            tone="warning"
            title="Sign in with your company account first"
            action={
              sso.provider && (
                <CTAButton type="secondary" size="md" to={`/sso?provider=${sso.provider.supabaseProviderId}`}>
                  Sign in with your company account
                </CTAButton>
              )
            }>
            You signed in with a password. Sign in with your company account, then require it here: that shows the company sign-in works before
            everyone depends on it.
          </Callout>
        ) : (
          <p className="text-sm text-secondary-text">
            Members will have to sign in with their company account. Sessions end after{" "}
            {sso.sessionHours.stored ? `${sso.sessionHours.stored} hours` : "12 hours"}. New invitations go only to addresses at your verified domains.
          </p>
        )}
        {blocked.length > 0 && (
          <Callout tone="warning" title={`${blocked.length} ${blocked.length === 1 ? "member signs" : "members sign"} in with a password`}>
            They will be blocked until they sign in with their company account: {blocked.slice(0, 8).map(personWords).join(", ")}
            {blocked.length > 8 ? ` and ${blocked.length - 8} more` : ""}. A company sign-in is a new account, so they will need inviting again with their
            company address.
          </Callout>
        )}
        {sso.breakGlass.length === 0 && (
          <Callout tone="info" title="No break-glass members">
            If the company sign-in stops working, only Fortress support can let anyone in. Consider naming a break-glass member first.
          </Callout>
        )}
        <Field label='Type "require" to confirm' required value={typed} onChange={(e) => setTyped(e.target.value)} disabled={!sso.session.viaSso} />
        {problem && <Callout tone="error" role="alert">{problem}</Callout>}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton type="danger" size="md" buttonType="submit" disabled={!sso.session.viaSso} loading={mutate.isPending}>
            Require single sign-on
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
}
