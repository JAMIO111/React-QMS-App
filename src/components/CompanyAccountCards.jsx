import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import CTAButton from "@/components/CTAButton";
import Callout from "./ui/Callout";
import Field from "./ui/Field";
import { useMe } from "../hooks/useQmsApi";
import { apiFetch, describeApiError } from "../lib/api-client";

/**
 * For someone signed in with their company account (docs/sso-plan.md SS4, SS5): organisations they may join by themselves, and organisations
 * where their old password account can be brought across by typing its password. Shows nothing when there is neither.
 */
export default function CompanyAccountCards() {
  const me = useMe();
  const joinable = me.data?.sso?.joinable ?? [];
  const moves = me.data?.sso?.moveCandidates ?? [];
  if (!joinable.length && !moves.length) return null;
  return (
    <section aria-labelledby="company-account-heading" className="flex flex-col gap-3">
      <h2 id="company-account-heading" className="text-lg font-semibold">
        With your company account
      </h2>
      {moves.map((o) => (
        <MoveCard key={`move-${o.id}`} organisation={o} />
      ))}
      {joinable.map((o) => (
        <JoinCard key={`join-${o.id}`} organisation={o} />
      ))}
    </section>
  );
}

const refreshAll = (queryClient) => queryClient.invalidateQueries();

function JoinCard({ organisation }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const join = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await apiFetch("/me/sso-join", { method: "POST", body: { organisationId: organisation.id } });
      await refreshAll(queryClient);
    } catch (error) {
      setProblem(describeApiError(error));
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border-color p-4" aria-label={`Join ${organisation.name}`}>
      <p className="text-sm text-primary-text">
        <strong>{organisation.name}</strong> lets people at your company join with their company account. You will start as{" "}
        {/^[aeiou]/i.test(organisation.roleName) ? "an" : "a"} {organisation.roleName.toLowerCase()}; an administrator can give you more.
      </p>
      {problem && <Callout tone="error" role="alert">{problem}</Callout>}
      <CTAButton type="main" size="md" className="self-start" onClick={join} loading={busy} loadingText="Joining">
        Join {organisation.name}
      </CTAButton>
    </div>
  );
}

function MoveCard({ organisation }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const move = async (e) => {
    e.preventDefault();
    setProblem(null);
    if (!password) return setProblem("Type the password you used to sign in to Fortress before.");
    setBusy(true);
    try {
      await apiFetch("/me/move-to-sso", { method: "POST", body: { organisationId: organisation.id, password } });
      setPassword("");
      await refreshAll(queryClient);
    } catch (error) {
      setProblem(describeApiError(error));
      setBusy(false);
    }
  };
  return (
    <form noValidate onSubmit={move} className="flex flex-col gap-3 rounded-xl border border-border-color p-4" aria-label={`Bring your account at ${organisation.name} across`}>
      <p className="text-sm text-primary-text">
        You used to sign in to <strong>{organisation.name}</strong> with an email and password. Bring that account across to your company account: your
        roles, seat and open work come with you. Type your old password to show it is yours.
      </p>
      <Field label="Your old Fortress password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {problem && <Callout tone="error" role="alert">{problem}</Callout>}
      <CTAButton type="main" size="md" buttonType="submit" className="self-start" loading={busy} loadingText="Bringing it across">
        Bring my account across
      </CTAButton>
      <p className="text-xs text-secondary-text">Forgotten it? Ask an administrator of {organisation.name} to move your account for you.</p>
    </form>
  );
}
