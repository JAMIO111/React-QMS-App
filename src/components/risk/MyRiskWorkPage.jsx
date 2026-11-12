import { useState } from "react";
import { Link } from "react-router-dom";
import { ShieldAlertIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import Callout from "../ui/Callout";
import CTAButton from "../CTAButton";
import { Card } from "../dashboard/DashboardParts";
import { Chip, Empty, headerLink as linkClass } from "../dashboard/DashboardGraphics";
import { useMyRiskWork } from "../../hooks/useRisk";
import { describeApiError } from "../../lib/api-client";
import { BAND_PILL, bandLabel, formatDay, riskPath } from "../../lib/risk";
import { TextDialog } from "./RiskTreatment";

const dueWords = (days) => (days < 0 ? `${-days} ${days === -1 ? "day" : "days"} overdue` : days === 0 ? "due today" : `due in ${days} ${days === 1 ? "day" : "days"}`);

/**
 * My risk work (`/Risk/My-Work`, menu badge "my-risk-work"): risks I own that are due for review (overdue or within 30 days), risk actions given to me (closed from here
 * with what was done), and acceptances waiting for me to decide (decided on the risk's page). The badge counts overdue reviews, open actions and acceptances.
 */
const MyRiskWorkPage = () => {
  const { data, isLoading, error } = useMyRiskWork();
  const [done, setDone] = useState(null);
  const total = data ? data.reviews.length + data.actions.length + data.acceptances.length : 0;

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <ShieldAlertIcon className="h-6 w-6" aria-hidden="true" />
            My risk work
          </h1>
          <p className="text-sm text-secondary-text">Reviews of risks you own, actions given to you and acceptances waiting for your decision</p>
        </div>
        <Link to="/Risk/Register?owner=me" className={linkClass}>
          Risks I own
        </Link>
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}
      {data && total === 0 && <Callout tone="success">Nothing needs you at the moment.</Callout>}

      <Card title="Actions given to you" subtitle="Open risk actions; mark one done with what was done">
        {data?.actions.length ? (
          <ul aria-label="My risk actions" className="flex flex-col divide-y divide-border-color text-sm">
            {data.actions.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium text-primary-text">{a.description}</span>
                  <span className="text-xs text-secondary-text">
                    <Link to={riskPath(a.riskId)} className="hover:underline">
                      {a.reference} · {a.title}
                    </Link>
                    {a.dueDate ? ` · due ${formatDay(a.dueDate)}` : ""}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {a.overdue && <Chip tone="error">overdue</Chip>}
                  <CTAButton type="secondary" onClick={() => setDone(a)} aria-label={`Mark done: ${a.description}`}>
                    Mark done
                  </CTAButton>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{isLoading ? "Loading…" : "No open actions are given to you."}</Empty>
        )}
      </Card>

      <Card title="Reviews due" subtitle="Risks you own whose review is overdue or due within 30 days; record the review on the risk">
        {data?.reviews.length ? (
          <ul aria-label="My reviews due" className="flex flex-col divide-y divide-border-color text-sm">
            {data.reviews.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span className="flex min-w-0 flex-col">
                  <Link to={riskPath(r.id)} className="font-medium text-primary-text hover:underline">
                    {r.reference} · {r.title}
                  </Link>
                  <span className="text-xs text-secondary-text">Review {formatDay(r.nextReviewOn)}</span>
                </span>
                <span className="flex items-center gap-2">
                  {r.band && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BAND_PILL[r.band]}`}>{bandLabel(r.band)}</span>}
                  <Chip tone={r.days < 0 ? "error" : "warning"}>{dueWords(r.days)}</Chip>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{isLoading ? "Loading…" : "None of your risks is due for review within 30 days."}</Empty>
        )}
      </Card>

      {data?.acceptances.length > 0 && (
        <Card title="Waiting for your decision" subtitle="Someone proposes living with these risks above the level the organisation accepts">
          <ul aria-label="Acceptances waiting for me" className="flex flex-col divide-y divide-border-color text-sm">
            {data.acceptances.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span className="flex min-w-0 flex-col">
                  <Link to={riskPath(a.riskId)} className="font-medium text-primary-text hover:underline">
                    {a.reference} · {a.title}
                  </Link>
                  <span className="text-xs text-secondary-text">
                    {a.proposedBy ?? "Someone"}: {a.rationale}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BAND_PILL[a.band]}`}>{bandLabel(a.band)}</span>
                  <CTAButton type="secondary" to={riskPath(a.riskId)}>
                    Decide
                  </CTAButton>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {done && (
        <TextDialog title="Mark the action done" intro={done.description} label="What was done" field="note" min={1} max={2000} confirm="Mark done" command={{ action: "completeAction", id: done.id }} onClose={() => setDone(null)} />
      )}
    </div>
  );
};

export default MyRiskWorkPage;
