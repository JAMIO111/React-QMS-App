import { useState } from "react";
import MenuCard from "../../ui/MenuCard";
import Callout from "../../ui/Callout";
import Dialog from "../../ui/Dialog";
import CTAButton from "@/components/CTAButton";
import { DownloadIcon } from "@/components/icons";
import { useAgentMutation } from "../../../hooks/useAgents";
import { useToast } from "../../../contexts/ToastProvider";
import { describeApiError } from "../../../lib/api-client";
import { platformLabel, sizeWords, updateOpen, updateStatus } from "../../../lib/agents";
import { Pill } from "./AgentsPage";

const day = (iso) => (iso ? new Date(iso).toLocaleString("en-GB") : "");

/** Confirm an update: what happens, that the release is signed, that the old version comes back if the new one does not start. */
const ApproveDialog = ({ agent, release, onClose }) => {
  const mutate = useAgentMutation();
  const { showToast } = useToast();
  const approve = () =>
    mutate.mutate(
      { action: "approveUpdate", id: agent.id, body: { releaseId: release.id } },
      { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "The update was not approved", message: describeApiError(err) }) },
    );
  return (
    <Dialog title={`Update ${agent.name} to version ${release.version}?`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-primary-text">
          <li>The agent downloads version {release.version} ({sizeWords(release.sizeBytes)}) and checks it was signed by Fortress&apos;s release key.</li>
          <li>It stops for a moment while the new version is put in place, then starts again. Imports that were running carry on where they stopped.</li>
          <li>If the new version does not check in within 5 minutes, the agent puts the previous version back on its own.</li>
        </ol>
        {release.notes && (
          <div className="rounded-lg bg-secondary-bg p-3 text-sm text-primary-text">
            <p className="mb-1 text-xs text-secondary-text">What is new</p>
            <p className="whitespace-pre-line">{release.notes}</p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>
            Not now
          </CTAButton>
          <CTAButton type="main" size="md" icon={DownloadIcon} onClick={approve} loading={mutate.isPending} loadingText="Approving">
            Update to {release.version}
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

/**
 * Updates (docs/connector-agent-plan.md AG6b): the version and platform the agent runs, a newer release when Fortress has published one, and the
 * updates approved for it. Nothing updates on its own: someone who manages integrations approves each one, and may cancel it until the agent takes it.
 */
const AgentUpdates = ({ agent, canManage }) => {
  const mutate = useAgentMutation();
  const { showToast } = useToast();
  const [approving, setApproving] = useState(false);
  const updates = agent.updates ?? [];
  const open = updates.find((u) => updateOpen(u.status));
  const next = agent.availableUpdate;
  const active = agent.status === "active";
  const cancel = (u) =>
    mutate.mutate(
      { action: "cancelUpdate", id: u.id },
      { onError: (err) => showToast({ type: "error", title: "The update was not cancelled", message: describeApiError(err) }) },
    );
  return (
    <MenuCard
      title="Updates"
      subtitle="An agent is only updated when someone who manages integrations approves it. Every release is signed, and the agent refuses one that is not."
      action={
        canManage &&
        active &&
        next &&
        !open && (
          <CTAButton type="main" size="default" icon={DownloadIcon} onClick={() => setApproving(true)}>
            Update to {next.version}
          </CTAButton>
        )
      }>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-primary-text">
          Running version {agent.version ?? "—"} on {platformLabel(agent.platform)}.
        </p>
        {!agent.platform && active && (
          <Callout tone="info">This agent is older than updates from Fortress, so it does not say which platform it runs on. Install the new version on its machine by hand.</Callout>
        )}
        {next && !open && (
          <Callout tone="info" title={`Version ${next.version} is available`}>
            Published {new Date(next.publishedAt).toLocaleDateString("en-GB")}
            {next.notes ? `: ${next.notes}` : "."}
            {!canManage && " Someone who manages integrations can approve it."}
          </Callout>
        )}
        {!next && !open && agent.platform && <p className="text-sm text-secondary-text">This agent runs the newest version.</p>}
        {open && (
          <Callout tone={open.status === "staged" ? "warning" : "info"} title={`Updating to version ${open.toVersion}`}>
            {updateStatus(open.status).label}
            {open.status === "waiting" && !agent.online ? ". The agent is offline; it will take the update when it is back." : "."}
            {open.status === "waiting" && canManage && (
              <CTAButton type="neutral" size="default" className="mt-2" onClick={() => cancel(open)}>
                Cancel the update
              </CTAButton>
            )}
          </Callout>
        )}
        {updates.length > 0 && (
          <ul aria-label="Updates" className="flex flex-col divide-y divide-border-color">
            {updates.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm text-primary-text">
                    {u.fromVersion ? `${u.fromVersion} → ` : "To "}
                    {u.toVersion}
                  </span>
                  <span className="text-xs text-secondary-text">
                    Approved {day(u.approvedAt)}
                    {u.approvedBy ? ` by ${u.approvedBy}` : ""}
                    {u.finishedAt ? ` · finished ${day(u.finishedAt)}` : ""}
                    {u.message ? ` · ${u.message}` : ""}
                  </span>
                </div>
                <Pill tone={updateStatus(u.status).tone}>{updateStatus(u.status).label}</Pill>
              </li>
            ))}
          </ul>
        )}
      </div>
      {approving && next && <ApproveDialog agent={agent} release={next} onClose={() => setApproving(false)} />}
    </MenuCard>
  );
};

export default AgentUpdates;
