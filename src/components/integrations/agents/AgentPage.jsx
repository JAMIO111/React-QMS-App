import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import MenuCard from "../../ui/MenuCard";
import Callout from "../../ui/Callout";
import LoadingScreen from "../../ui/LoadingScreen";
import RowActionsMenu from "../../ui/RowActionsMenu";
import CTAButton from "@/components/CTAButton";
import { ActivityIcon, KeyRoundIcon, StethoscopeIcon } from "@/components/icons";
import { usePermissions } from "../../../hooks/useQmsApi";
import { useAgent, useAgentJob, useAgentMutation } from "../../../hooks/useAgents";
import { useToast } from "../../../contexts/ToastProvider";
import { describeApiError } from "../../../lib/api-client";
import { useBreadcrumbNames } from "../../../lib/breadcrumbs";
import { agentState, agentsPath, ago, diagnosticsFacts, eventWords, jobKind, jobRunning, jobStatus, pingWords } from "../../../lib/agents";
import { AddAgentDialog, RenameAgentDialog, RevokeAgentDialog } from "./AgentDialogs";
import { Pill } from "./AgentsPage";
import AgentUpdates from "./AgentUpdates";

const Fact = ({ label, children }) => (
  <div className="flex flex-col">
    <dt className="text-xs text-secondary-text">{label}</dt>
    <dd className="text-sm text-primary-text">{children || "—"}</dd>
  </div>
);

/** Check the agent: a ping job, followed until the agent answers. */
const PingCard = ({ agent, canManage }) => {
  const mutate = useAgentMutation();
  const { showToast } = useToast();
  const [jobId, setJobId] = useState(null);
  const job = useAgentJob(jobId);
  const running = jobId && (!job.data || jobRunning(job.data.status));
  const ping = () =>
    mutate.mutate(
      { action: "ping", id: agent.id, body: {} },
      { onSuccess: (j) => setJobId(j.id), onError: (err) => showToast({ type: "error", title: "The check could not be sent", message: describeApiError(err) }) },
    );
  return (
    <MenuCard
      title="Check the agent"
      subtitle="Sends the agent a ping. It answers on its next poll: within seconds while this page is open, else within a minute."
      action={
        canManage && agent.status === "active" && (
          <CTAButton type="main" size="default" icon={ActivityIcon} onClick={ping} loading={mutate.isPending || running} loadingText="Waiting for the agent">
            Check now
          </CTAButton>
        )
      }>
      {!jobId ? (
        <p className="text-sm text-secondary-text">{agent.online ? "The agent is online." : "The agent has not been seen for a while; a check will wait until it is back."}</p>
      ) : job.data?.status === "completed" ? (
        <Callout tone="success">{pingWords(job.data)}</Callout>
      ) : job.data && ["failed", "cancelled"].includes(job.data.status) ? (
        <Callout tone="error" title={jobStatus(job.data.status).label}>
          {job.data.errorMessage}
        </Callout>
      ) : (
        <p role="status" className="text-sm text-secondary-text">
          {job.data ? jobStatus(job.data.status).label : "Sending…"}
        </p>
      )}
    </MenuCard>
  );
};

/** Ask the agent for a job of its own (rotate its keys, send diagnostics) and follow it until it answers. */
const useAgentAsk = (agent, action, failTitle) => {
  const mutate = useAgentMutation();
  const { showToast } = useToast();
  const [jobId, setJobId] = useState(null);
  const job = useAgentJob(jobId);
  const running = !!jobId && (!job.data || jobRunning(job.data.status));
  const ask = () =>
    mutate.mutate(
      { action, id: agent.id, body: {} },
      { onSuccess: (j) => setJobId(j.id), onError: (err) => showToast({ type: "error", title: failTitle, message: describeApiError(err) }) },
    );
  return { ask, job: jobId ? job.data : null, busy: mutate.isPending || running };
};

const JobOutcome = ({ job, done }) =>
  !job ? null : job.status === "completed" ? (
    done
  ) : ["failed", "cancelled"].includes(job.status) ? (
    <Callout tone="error" title={jobStatus(job.status).label}>
      {job.errorMessage}
    </Callout>
  ) : (
    <p role="status" className="text-sm text-secondary-text">
      {jobStatus(job.status).label}
    </p>
  );

/** AG6a: rotate the agent's keys now (it also does so every 90 days on its own) and collect a diagnostics bundle for support. */
const MaintenanceCard = ({ agent, canManage }) => {
  const rotate = useAgentAsk(agent, "rotateKeys", "The key rotation could not be asked for");
  const diag = useAgentAsk(agent, "diagnostics", "Diagnostics could not be asked for");
  const active = canManage && agent.status === "active";
  const bundle = diag.job?.status === "completed" ? diag.job.result : null;
  const facts = diagnosticsFacts(bundle);
  return (
    <MenuCard
      title="Keys and diagnostics"
      subtitle="The agent replaces its keys every 90 days on its own; the key before is kept for 30 days so a password sealed just before still opens. Diagnostics never hold passwords, keys or records.">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          {active && (
            <CTAButton type="secondary" size="default" icon={KeyRoundIcon} onClick={rotate.ask} loading={rotate.busy} loadingText="Rotating keys">
              Rotate keys now
            </CTAButton>
          )}
          {active && (
            <CTAButton type="secondary" size="default" icon={StethoscopeIcon} onClick={diag.ask} loading={diag.busy} loadingText="Collecting">
              Collect diagnostics
            </CTAButton>
          )}
          {!active && <p className="text-sm text-secondary-text">Only someone who manages integrations can rotate keys or collect diagnostics.</p>}
        </div>
        <JobOutcome
          job={rotate.job}
          done={<Callout tone="success">Keys rotated{rotate.job?.result?.fingerprint ? `: the new fingerprint is ${rotate.job.result.fingerprint}` : ""}.</Callout>}
        />
        <JobOutcome
          job={diag.job}
          done={
            bundle?.cleared ? (
              <Callout tone="info">This bundle was cleared after 30 days.</Callout>
            ) : (
              <section aria-label="Diagnostics" className="flex flex-col gap-3">
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {facts.map(([label, value]) => (
                    <Fact key={label} label={label}>
                      {value}
                    </Fact>
                  ))}
                </dl>
                {bundle?.allowList && (
                  <details>
                    <summary className="cursor-pointer text-sm text-primary-text">Allow-list on the agent</summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-secondary-bg p-3 text-xs">{bundle.allowList}</pre>
                  </details>
                )}
                {!!bundle?.log?.length && (
                  <details>
                    <summary className="cursor-pointer text-sm text-primary-text">Last {bundle.log.length} log lines</summary>
                    <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-secondary-bg p-3 text-xs">{bundle.log.join("\n")}</pre>
                  </details>
                )}
                <CTAButton
                  type="neutral"
                  size="default"
                  className="self-start"
                  onClick={() => {
                    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${agent.name}-diagnostics.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}>
                  Download as a file
                </CTAButton>
              </section>
            )
          }
        />
      </div>
    </MenuCard>
  );
};

/** One connector agent (docs/connector-agent-plan.md AG1): who and where it is, whether it is online, checking it, its jobs and history. */
const AgentPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const agent = useAgent(id);
  const mutate = useAgentMutation();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null);
  const canManage = can("integrations.manage");
  const a = agent.data;
  useBreadcrumbNames([{ path: `/Settings/Integrations/Agents/${id}`, label: a?.name ?? null }, { path: "/Settings/Integrations/Agents", label: "Connector agents", to: agentsPath() }]);
  // While someone is looking, ask the agent to poll quickly so a check answers within seconds.
  const wake = mutate.mutate;
  useEffect(() => {
    if (id) wake({ action: "wake", id });
  }, [id, wake]);

  if (agent.isLoading) return <LoadingScreen />;
  if (agent.error || !a) {
    return (
      <div className="p-4">
        <Callout tone="error" title="This agent could not be found">
          <Link to={agentsPath()} className="text-link-color hover:underline">
            Back to connector agents
          </Link>
        </Callout>
      </div>
    );
  }
  const s = agentState(a);
  return (
    <div className="flex flex-col gap-4">
      <MenuCard
        title={a.name}
        subtitle={a.location ?? "Connector agent"}
        action={
          <div className="flex items-center gap-2">
            <Pill tone={s.tone}>{s.label}</Pill>
            {canManage && a.status === "active" && (
              <RowActionsMenu
                label={`Actions for ${a.name}`}
                items={[
                  { label: "Rename", onSelect: () => setDialog("rename") },
                  { label: "Reinstall on another machine", onSelect: () => setDialog("replace") },
                  { separator: true },
                  { label: "Revoke", tone: "danger", onSelect: () => setDialog("revoke") },
                ]}
              />
            )}
          </div>
        }>
        {a.status === "revoked" && (
          <Callout tone="error" title="Revoked">
            {a.revokedReason}
            {a.revokedBy ? ` — ${a.revokedBy}` : ""}, {new Date(a.revokedAt).toLocaleString("en-GB")}. It cannot connect again.
          </Callout>
        )}
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Fact label="Last seen">{a.lastHeartbeatAt ? `${ago(a.lastHeartbeatAt)} (${new Date(a.lastHeartbeatAt).toLocaleString("en-GB")})` : "Never"}</Fact>
          <Fact label="Machine">{a.machineName}</Fact>
          <Fact label="Operating system">{a.operatingSystem}</Fact>
          <Fact label="Agent version">{a.version}</Fact>
          <Fact label="Connects from">{a.lastAddress}</Fact>
          <Fact label="Registered">
            {new Date(a.registeredAt).toLocaleDateString("en-GB")}
            {a.registeredBy ? ` by ${a.registeredBy}` : ""}
          </Fact>
          <Fact label="Key fingerprint">
            <span className="font-mono">{a.keys.find((k) => k.status === "active")?.fingerprint}</span>
          </Fact>
        </dl>
      </MenuCard>

      <PingCard agent={a} canManage={canManage} />

      <AgentUpdates agent={a} canManage={canManage} />

      <MaintenanceCard agent={a} canManage={canManage} />

      <MenuCard title="Recent jobs" subtitle="What Fortress has asked this agent to do.">
        {!a.jobs.length ? (
          <p className="text-sm text-secondary-text">Nothing yet.</p>
        ) : (
          <ul aria-label="Recent jobs" className="flex flex-col divide-y divide-border-color">
            {a.jobs.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm text-primary-text">{jobKind(j.kind)}</span>
                  <span className="text-xs text-secondary-text">
                    {new Date(j.createdAt).toLocaleString("en-GB")}
                    {j.requestedBy ? ` · ${j.requestedBy}` : ""}
                    {j.errorMessage && j.status !== "completed" ? ` · ${j.errorMessage}` : ""}
                  </span>
                </div>
                <Pill tone={jobStatus(j.status).tone}>{jobStatus(j.status).label}</Pill>
              </li>
            ))}
          </ul>
        )}
      </MenuCard>

      <MenuCard title="History" subtitle="Registration, updates, key changes and problems.">
        <ul aria-label="History" className="flex flex-col gap-1">
          {a.events.map((e, i) => (
            <li key={`${e.at}-${i}`} className="text-sm text-primary-text">
              <span className="text-xs text-secondary-text">{new Date(e.at).toLocaleString("en-GB")} · </span>
              {eventWords(e)}
              {e.by ? <span className="text-xs text-secondary-text"> — {e.by}</span> : null}
            </li>
          ))}
        </ul>
      </MenuCard>

      {dialog === "rename" && (
        <RenameAgentDialog
          agent={a}
          onClose={() => setDialog(null)}
          onSave={(body) => mutate.mutate({ action: "rename", id: a.id, body }, { onError: (err) => showToast({ type: "error", title: "Not renamed", message: describeApiError(err) }) })}
        />
      )}
      {dialog === "revoke" && <RevokeAgentDialog agent={a} onClose={() => setDialog(null)} />}
      {dialog === "replace" && <AddAgentDialog replaces={a} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default AgentPage;
