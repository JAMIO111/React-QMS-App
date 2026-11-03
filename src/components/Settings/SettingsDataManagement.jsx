import { Link } from "react-router-dom";
import Accordion from "./Accordion";
import ClassificationList from "./ClassificationList";
import { usePermissions } from "../../hooks/useQmsApi";
import { useClassifications } from "../../hooks/useNcr";
import { STAGES } from "../../lib/ncr";
import { StagePill } from "../ncr/Pills";
import { describeApiError } from "../../lib/api-client";

const STAGE_HELP = {
  draft: "Being written; not yet raised.",
  open: "Raised: severity, quantity and (for customer/supplier NCs) the customer or supplier are recorded.",
  contained: "Affected product is secured.",
  investigating: "Root cause is being investigated.",
  dispositioned: "A decision has been made on the affected product.",
  awaiting_closure: "Corrective action is being verified.",
  closed: "Complete. Locked until reopened (with a reason).",
  cancelled: "Raised in error or a duplicate (with a reason). Locked until reopened.",
};

const SettingsDataManagement = () => {
  const { can } = usePermissions();
  const canManage = can("lookups.manage");
  const { data: lists, error } = useClassifications({ includeInactive: true });

  return (
    <div className="flex flex-col pr-2 gap-3 w-full grow">
      <h2 className="text-primary-text text-2xl pb-2 font-semibold">Data Management</h2>
      <p className="text-secondary-text mb-2">
        Lists used when recording non-conformances.{canManage ? "" : " You can view them; an administrator can change them."}
      </p>
      {error && (
        <p role="alert" className="text-error-color">
          {describeApiError(error)}
        </p>
      )}
      <Accordion title="Failure modes" subtitle="Failure modes and their sub-failure modes">
        {lists && <ClassificationList kind="failure_mode" lists={lists} canManage={canManage} />}
      </Accordion>
      <Accordion title="Processes" subtitle="Processes and work stations (where detected, causal process)">
        {lists && <ClassificationList kind="process" lists={lists} canManage={canManage} />}
      </Accordion>
      <Accordion title="NCR stages" subtitle="How a non-conformance moves from draft to closed">
        <ul className="flex flex-col gap-2 py-2">
          {STAGES.map((s) => (
            <li key={s.key} className="flex items-start gap-3 text-sm text-primary-text">
              <span className="w-36 shrink-0">
                <StagePill stage={s.key} />
              </span>
              {STAGE_HELP[s.key]}
            </li>
          ))}
        </ul>
      </Accordion>
      <Accordion title="Customers, suppliers and products" subtitle="Managed under Master Data">
        <p className="flex flex-wrap gap-4 py-2 text-sm">
          <Link to="/Customers" className="text-link-color hover:underline">Customers</Link>
          <Link to="/Suppliers" className="text-link-color hover:underline">Suppliers</Link>
          <Link to="/Parts" className="text-link-color hover:underline">Parts</Link>
        </p>
      </Accordion>
    </div>
  );
};

export default SettingsDataManagement;
