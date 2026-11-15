import { useState } from "react";
import { useToast } from "../../../contexts/ToastProvider";
import { useAgentJob } from "../../../hooks/useAgents";
import { useIntegrationMutation } from "../../../hooks/useIntegrations";
import { describeApiError } from "../../../lib/api-client";
import { agentJobRunning } from "../../../lib/integrations";
import Callout from "../../ui/Callout";

export const JOB_STATUS = { pending: "Waiting for the agent", received: "The agent has it", running: "Running", completed: "Done", failed: "Failed", cancelled: "Cancelled" };

/** Ask the connection's agent something (browse, preview) and follow the job until it answers (AG2). */
export const useAsk = (connectionId) => {
  const mutation = useIntegrationMutation();
  const { showToast } = useToast();
  const [jobId, setJobId] = useState(null);
  const job = useAgentJob(jobId);
  const ask = (kind, request) =>
    mutation.mutate(
      { action: "connectionJob", id: connectionId, body: { kind, request } },
      { onSuccess: (j) => setJobId(j.id), onError: (err) => showToast({ type: "error", title: "Not asked", message: describeApiError(err) }) },
    );
  const busy = mutation.isPending || (!!jobId && (!job.data || agentJobRunning(job.data.status)));
  return { ask, busy, job: job.data, reset: () => setJobId(null) };
};

export const Waiting = ({ job }) => (
  <p role="status" className="text-sm text-secondary-text">
    {job ? JOB_STATUS[job.status] : "Asking the agent…"}
  </p>
);

export const Failed = ({ job }) => (
  <Callout tone="error" title="The agent could not do it">
    {job.errorMessage}
  </Callout>
);

