import { Link } from "react-router-dom";
import { GitPullRequestArrowIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import Callout from "../ui/Callout";
import { Card } from "../dashboard/DashboardParts";
import { Chip, Empty, headerLink as linkClass } from "../dashboard/DashboardGraphics";
import { useMyChanges } from "../../hooks/useChange";
import { describeApiError } from "../../lib/api-client";
import { changePath, formatDay, linkStateLabel, stageLabel, taskLinkKindLabel } from "../../lib/change";

/**
 * My changes (`/Change/Mine`, menu badge "my-changes"): changes waiting for my sign-off, the tasks given to me (finished on the change's page, where the
 * record they change is shown), and the changes I raised that are still going. The badge counts sign-offs plus open tasks.
 */
const MyChangesPage = () => {
  const { data, isLoading, error } = useMyChanges();
  const total = data?.counts.total ?? 0;
  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <GitPullRequestArrowIcon className="h-6 w-6" aria-hidden="true" />
            My changes
          </h1>
          <p className="text-sm text-secondary-text">Sign-offs waiting for you, tasks given to you and the changes you raised</p>
        </div>
        <Link to="/Change" className={linkClass}>
          All changes
        </Link>
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}
      {data && total === 0 && <Callout tone="success">Nothing needs you at the moment.</Callout>}

      <Card title="Waiting for your sign-off" subtitle="Changes with the board where you are named to sign; open one to decide">
        {data?.signoffs.length ? (
          <ul aria-label="Sign-offs waiting for me" className="flex flex-col divide-y divide-border-color text-sm">
            {data.signoffs.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span className="flex min-w-0 flex-col">
                  <Link to={changePath(s.changeId)} className="font-medium text-primary-text hover:underline">
                    {s.reference} · {s.title}
                  </Link>
                  <span className="text-xs text-secondary-text">Sign off for {s.functionLabel}</span>
                </span>
                {s.urgency === "expedited" && <Chip tone="warning">expedited</Chip>}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{isLoading ? "Loading…" : "No sign-offs are waiting for you."}</Empty>
        )}
      </Card>

      <Card title="Tasks given to you" subtitle="Open tasks on approved changes; finish one on its change">
        {data?.tasks.length ? (
          <ul aria-label="My change tasks" className="flex flex-col divide-y divide-border-color text-sm">
            {data.tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium text-primary-text">{t.description}</span>
                  <span className="text-xs text-secondary-text">
                    <Link to={changePath(t.changeId)} className="hover:underline">
                      {t.reference} · {t.title}
                    </Link>
                    {t.dueOn ? ` · due ${formatDay(t.dueOn)}` : ""}
                    {t.linkKind ? ` · ${taskLinkKindLabel(t.linkKind).toLowerCase()}${linkStateLabel(t.linkState) ? `: ${linkStateLabel(t.linkState).toLowerCase()}` : ""}` : ""}
                  </span>
                </span>
                {t.overdue && <Chip tone="error">overdue</Chip>}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{isLoading ? "Loading…" : "No tasks are given to you."}</Empty>
        )}
      </Card>

      <Card title="Changes you raised" subtitle="Still going: not yet closed, rejected or cancelled">
        {data?.raised.length ? (
          <ul aria-label="Changes I raised" className="flex flex-col divide-y divide-border-color text-sm">
            {data.raised.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <Link to={changePath(c.id)} className="font-medium text-primary-text hover:underline">
                  {c.reference} · {c.title}
                </Link>
                <Chip>{stageLabel(c.stage)}</Chip>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{isLoading ? "Loading…" : "None of your changes are still going."}</Empty>
        )}
      </Card>
    </div>
  );
};

export default MyChangesPage;
