import { useState } from "react";
import { Link } from "react-router-dom";
import { CircleAlertIcon, CircleCheckIcon } from "@/components/icons";
import MenuCard from "../ui/MenuCard";
import { useMyAlerts } from "../../hooks/useDocumentation";
import { formatDateTime } from "../../lib/processControl";
import { categoryLabel, formatDay, referenceText } from "../../lib/qualityAlerts";
import { ErrorNotice } from "../master-data/shared";
import { AcknowledgeDialog } from "./Acknowledge";
import { SeverityBadge, StatusPill } from "./shared";

const th = "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2 align-top";

const StateCell = ({ a }) => {
  if (a.state === "open") {
    return (
      <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${a.me.overdue ? "bg-error-color/15 text-error-color" : "bg-amber-500/15 text-amber-700 dark:text-amber-300"}`}>
        <CircleAlertIcon className="h-3.5 w-3.5" /> {a.me.overdue ? "Overdue" : "Needs acknowledging"}
      </span>
    );
  }
  if (a.state === "acknowledged") {
    return (
      <span>
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-success-color/15 px-2 py-0.5 text-xs font-medium text-success-color">
          <CircleCheckIcon className="h-3.5 w-3.5" /> Acknowledged
        </span>
        <span className="block text-xs text-secondary-text">{formatDateTime(a.me.acknowledgedAt)}</span>
      </span>
    );
  }
  return <StatusPill alert={a} />;
};

/**
 * Quality alerts addressed to the signed-in person: the ones still to be acknowledged first (overdue before the rest), then
 * the ones already acknowledged, then ended ones for 30 days (greyed). Acknowledging is "I have read and understood".
 */
const MyAlertsPage = () => {
  const query = useMyAlerts();
  const [acknowledging, setAcknowledging] = useState(null);
  const data = query.data?.data ?? [];

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h1 className="text-2xl font-semibold text-primary-text">My alerts</h1>
        <p className="text-sm text-secondary-text">Quality alerts addressed to you. Open each one, read what to do, and acknowledge it so there is a record that it reached you.</p>
      </div>
      <MenuCard
        title="Addressed to me"
        subtitle={query.data ? `${query.data.unacknowledged} to acknowledge${query.data.overdue ? `, ${query.data.overdue} overdue` : ""}` : undefined}>
        {query.isLoading && <p className="text-secondary-text">Loading…</p>}
        {query.error && <ErrorNotice error={query.error} />}
        {query.data && data.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-primary-text">
            <CircleCheckIcon className="h-4 w-4" /> No quality alerts are addressed to you.
          </p>
        )}
        {data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-separate border-spacing-0 text-sm text-primary-text" aria-label="My alerts">
              <thead>
                <tr>
                  <th scope="col" className={th}>Alert</th>
                  <th scope="col" className={th}>Title</th>
                  <th scope="col" className={th}>Severity</th>
                  <th scope="col" className={th}>Acknowledge by</th>
                  <th scope="col" className={th}>Status</th>
                  <th scope="col" className={th}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {data.map((a) => (
                  <tr key={a.id} className={a.state === "closed" ? "opacity-60" : ""}>
                    <td className={`${td} whitespace-nowrap`}>
                      <Link to={`/Documentation/Quality-Alerts/${a.id}`} className="font-medium text-link-color hover:underline">
                        {referenceText(a)}
                      </Link>
                      <span className="block text-xs text-secondary-text">{categoryLabel(a.category)}</span>
                    </td>
                    <td className={td}>{a.title}</td>
                    <td className={td}><SeverityBadge severity={a.severity} /></td>
                    <td className={`${td} whitespace-nowrap`}>{formatDay(a.acknowledgeBy)}</td>
                    <td className={td}><StateCell a={a} /></td>
                    <td className={td}>
                      {a.state === "open" && (
                        <button type="button" className="min-h-9.5 rounded-lg border border-border-color px-2 py-1 text-sm text-primary-text hover:border-border-dark-color cursor-pointer" onClick={() => setAcknowledging(a)}>
                          Acknowledge
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </MenuCard>
      {acknowledging && <AcknowledgeDialog alert={acknowledging} onClose={() => setAcknowledging(null)} />}
    </div>
  );
};

export default MyAlertsPage;
