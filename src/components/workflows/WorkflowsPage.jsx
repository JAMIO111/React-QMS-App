import { Link } from "react-router-dom";
import { PlusIcon, WorkflowIcon } from "@/components/icons";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import MenuCard from "../ui/MenuCard";
import { useWorkflowRules } from "../../hooks/useWorkflows";
import { usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { RULE_STATUS, when, workflowRulePath } from "../../lib/workflows";

const PILL = { success: "bg-success-color/15 text-success-color", warning: "bg-warning-color/20 text-primary-text", neutral: "bg-border-color text-secondary-text" };
export const RuleStatusPill = ({ status }) => (
  <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${PILL[RULE_STATUS[status]?.tone ?? "neutral"]}`}>{RULE_STATUS[status]?.label ?? status}</span>
);


/** Settings → Workflows (`/Settings/Workflows`): every rule, what starts it, whether it is on, its version and how often it ran. */
const WorkflowsPage = () => {
  const { can } = usePermissions();
  const rules = useWorkflowRules();
  const canManage = can("workflows.manage");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <WorkflowIcon aria-hidden="true" />
            Workflows
          </h1>
          <p className="text-sm text-secondary-text">
            Rules that tell people or give someone a task when something happens. They never change a record themselves.
          </p>
        </div>
        {canManage && (
          <CTAButton type="main" to={workflowRulePath("new")} icon={PlusIcon}>
            New rule
          </CTAButton>
        )}
      </div>
      {rules.error && (
        <Callout tone="error" role="alert">
          {describeApiError(rules.error)}
        </Callout>
      )}
      <MenuCard title="Rules" subtitle={rules.data ? `${rules.data.filter((r) => r.status === "active").length} active of ${rules.data.length}` : undefined}>
        {rules.isLoading ? (
          <p className="text-sm text-secondary-text">Loading…</p>
        ) : rules.data?.length ? (
          <table className="w-full text-left text-sm" aria-label="Workflow rules">
            <thead className="text-xs text-secondary-text">
              <tr>
                <th className="py-2 pr-3 font-medium">Rule</th>
                <th className="py-2 pr-3 font-medium">When</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Version</th>
                <th className="py-2 pr-3 font-medium">Runs</th>
                <th className="py-2 font-medium">Last ran</th>
              </tr>
            </thead>
            <tbody>
              {rules.data.map((r) => (
                <tr key={r.id} className="border-t border-border-color align-top">
                  <td className="py-2 pr-3">
                    <Link to={workflowRulePath(r.id)} className="font-medium text-primary-text hover:underline">
                      {r.name}
                    </Link>
                    <span className="block text-xs text-secondary-text">{r.reference}</span>
                  </td>
                  <td className="py-2 pr-3 text-primary-text">{r.triggerLabel}</td>
                  <td className="py-2 pr-3">
                    <RuleStatusPill status={r.status} />
                  </td>
                  <td className="py-2 pr-3 tabular-nums text-primary-text">{r.version}</td>
                  <td className="py-2 pr-3 tabular-nums text-primary-text">{r.runs}</td>
                  <td className="py-2 text-primary-text">{when(r.lastRunAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-secondary-text">
            No rules yet.{canManage ? " A rule might tell the quality manager when a major non-conformance is raised, or give the cell leader a task when a critical check fails." : ""}
          </p>
        )}
      </MenuCard>
    </div>
  );
};

export default WorkflowsPage;
