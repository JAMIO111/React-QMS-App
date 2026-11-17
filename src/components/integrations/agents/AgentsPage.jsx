import { useState } from "react";
import { Link } from "react-router-dom";
import MenuCard from "../../ui/MenuCard";
import Callout from "../../ui/Callout";
import LoadingScreen from "../../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";
import { PlusIcon, ServerIcon } from "@/components/icons";
import { usePermissions } from "../../../hooks/useQmsApi";
import { useAgentMutation, useAgentRegistrations, useAgents } from "../../../hooks/useAgents";
import { useToast } from "../../../contexts/ToastProvider";
import { describeApiError } from "../../../lib/api-client";
import { agentPath, agentState, ago } from "../../../lib/agents";
import { AddAgentDialog } from "./AgentDialogs";

export const Pill = ({ tone, children }) => {
  const cls = {
    success: "bg-success-color/15 text-success-color",
    warning: "bg-warning-color/15 text-warning-color",
    error: "bg-error-color/15 text-error-color",
    neutral: "bg-secondary-bg text-secondary-text",
  }[tone];
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
};

const Registrations = ({ canManage }) => {
  const list = useAgentRegistrations();
  const mutate = useAgentMutation();
  const { showToast } = useToast();
  const waiting = (list.data?.data ?? []).filter((g) => g.state === "waiting");
  if (!waiting.length) return null;
  return (
    <MenuCard title="Tokens not used yet" subtitle="Registrations waiting for an agent to be installed. A token works once and then expires.">
      <ul aria-label="Tokens not used yet" className="flex flex-col divide-y divide-border-color">
        {waiting.map((g) => (
          <li key={g.id} className="flex flex-wrap items-center gap-3 py-2">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium text-primary-text">{g.replaces ? `Reinstall ${g.replaces.name}` : g.name}</span>
              <span className="text-xs text-secondary-text">
                Made {ago(g.createdAt)}
                {g.createdBy ? ` by ${g.createdBy}` : ""} · valid until {new Date(g.expiresAt).toLocaleString("en-GB")}
              </span>
            </div>
            {canManage && (
              <CTAButton
                type="neutral"
                size="default"
                onClick={() => mutate.mutate({ action: "cancelRegistration", id: g.id }, { onError: (err) => showToast({ type: "error", title: "Not cancelled", message: describeApiError(err) }) })}>
                Cancel token
              </CTAButton>
            )}
          </li>
        ))}
      </ul>
    </MenuCard>
  );
};

/** Settings → Integrations → Connector agents (docs/connector-agent-plan.md AG1). */
const AgentsPage = () => {
  const { can } = usePermissions();
  const agents = useAgents({ enabled: can("integrations.read") });
  const [adding, setAdding] = useState(false);
  const canManage = can("integrations.manage");
  if (!can("integrations.read")) {
    return (
      <div className="p-4">
        <Callout tone="info" title="Connector agents are for Controller seat holders">
          Managing connector agents needs a Controller seat and a role that allows integrations.
        </Callout>
      </div>
    );
  }
  const data = agents.data?.data ?? [];
  const live = data.filter((a) => a.status === "active");
  const revoked = data.filter((a) => a.status === "revoked");
  return (
    <div className="flex flex-col gap-4">
      <MenuCard
        title="Connector agents"
        subtitle="Small Windows services installed inside your network. They connect out to Fortress and read only what you approve, so your databases are never exposed to the internet."
        action={
          canManage && (
            <CTAButton type="main" size="default" icon={PlusIcon} onClick={() => setAdding(true)}>
              Add a connector agent
            </CTAButton>
          )
        }>
        {agents.isLoading ? (
          <LoadingScreen />
        ) : !live.length ? (
          <p className="text-sm text-secondary-text">No agents yet.{canManage ? " Add one to connect a database inside your network." : ""}</p>
        ) : (
          <ul aria-label="Connector agents" className="flex flex-col divide-y divide-border-color">
            {live.map((a) => {
              const s = agentState(a);
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-3 py-3">
                  <ServerIcon className="text-xl text-secondary-text" aria-hidden />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <Link to={agentPath(a.id)} className="text-sm font-medium text-link-color hover:underline">
                      {a.name}
                    </Link>
                    <span className="text-xs text-secondary-text">
                      {[a.location, a.machineName, a.version ? `version ${a.version}` : null].filter(Boolean).join(" · ")}
                    </span>
                    {a.lastError && <span className="text-xs text-error-color">Last error: {a.lastError.message}</span>}
                  </div>
                  <span className="text-xs text-secondary-text">Last seen {ago(a.lastHeartbeatAt)}</span>
                  {a.activeJobs > 0 && <Pill tone="neutral">{a.activeJobs === 1 ? "1 job" : `${a.activeJobs} jobs`}</Pill>}
                  <Pill tone={s.tone}>{s.label}</Pill>
                </li>
              );
            })}
          </ul>
        )}
      </MenuCard>

      <Registrations canManage={canManage} />

      {revoked.length > 0 && (
        <MenuCard title="Revoked agents" subtitle="Kept for their history. A revoked agent cannot connect again.">
          <ul aria-label="Revoked agents" className="flex flex-col divide-y divide-border-color">
            {revoked.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-2">
                <Link to={agentPath(a.id)} className="min-w-0 flex-1 text-sm text-link-color hover:underline">
                  {a.name}
                </Link>
                <span className="text-xs text-secondary-text">{a.revokedReason}</span>
                <Pill tone="error">Revoked</Pill>
              </li>
            ))}
          </ul>
        </MenuCard>
      )}

      {adding && <AddAgentDialog onClose={() => setAdding(false)} />}
    </div>
  );
};

export default AgentsPage;
