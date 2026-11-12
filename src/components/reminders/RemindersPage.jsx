import { Link } from "react-router-dom";
import { AlarmClockIcon, BellOffIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import { Card } from "../dashboard/DashboardParts";
import { Chip, Empty } from "../dashboard/DashboardGraphics";
import { useMyReminders } from "../../hooks/useReminders";
import { describeApiError } from "../../lib/api-client";
import { dueWords } from "../../lib/reminders";

const Item = ({ item, today }) => (
  <li className="flex flex-wrap items-center justify-between gap-3 py-2">
    <span className="flex min-w-0 flex-col">
      {item.path ? (
        <Link to={item.path} className="font-medium text-primary-text hover:underline">
          {item.label}
        </Link>
      ) : (
        <span className="font-medium text-primary-text">{item.label}</span>
      )}
      <span className="text-xs text-secondary-text">{item.areaLabel}</span>
    </span>
    <span className="flex items-center gap-2">
      {!item.areaEnabled && (
        <span className="inline-flex items-center gap-1 text-xs text-secondary-text" title="You have switched reminders for this off">
          <BellOffIcon aria-hidden="true" /> Not reminded
        </span>
      )}
      <span className={`text-sm ${item.overdue ? "font-medium text-error-color" : "text-secondary-text"}`}>{dueWords(item.dueOn, today)}</span>
    </span>
  </li>
);

/**
 * My reminders (`/Reminders`): everything of mine that is overdue or due soon, across the modules, worked out now (WK2). The daily reminder notice leads here;
 * areas I switched off are still listed, marked. Open to every member: it only ever shows the person's own work they may read.
 */
const RemindersPage = () => {
  const { data, isLoading, error } = useMyReminders();
  const items = data?.data ?? [];
  const overdue = items.filter((i) => i.overdue);
  const soon = items.filter((i) => !i.overdue);

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <AlarmClockIcon className="h-6 w-6" aria-hidden="true" />
            My reminders
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            {data ? `${data.counts.overdue} overdue · ${data.counts.dueSoon} due soon` : "What of yours is overdue or due soon"}
          </p>
        </div>
        <CTAButton type="secondary" to="/Settings/Notifications">
          Choose what you are reminded about
        </CTAButton>
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}

      {isLoading ? (
        <Empty>Loading…</Empty>
      ) : items.length === 0 && !error ? (
        <Callout tone="success" title="Nothing due">
          Nothing of yours is overdue or due soon.
        </Callout>
      ) : (
        <>
          {overdue.length > 0 && (
            <Card title={<span className="flex items-center gap-2">Overdue <Chip>{overdue.length}</Chip></span>}>
              <ul aria-label="Overdue" className="flex flex-col divide-y divide-border-color text-sm">
                {overdue.map((i) => (
                  <Item key={`${i.area}-${i.recordId}`} item={i} today={data.today} />
                ))}
              </ul>
            </Card>
          )}
          {soon.length > 0 && (
            <Card title={<span className="flex items-center gap-2">Due soon <Chip>{soon.length}</Chip></span>}>
              <ul aria-label="Due soon" className="flex flex-col divide-y divide-border-color text-sm">
                {soon.map((i) => (
                  <Item key={`${i.area}-${i.recordId}`} item={i} today={data.today} />
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
};

export default RemindersPage;
