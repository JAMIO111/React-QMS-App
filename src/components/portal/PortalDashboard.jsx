import { useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import { PortalFigures } from "./PortalComplaints";
import { PerformancePanel } from "./PortalPerformancePage";
import SlidingToggle from "../ui/SlidingToggle";
import { Empty, SplitBar, StatTile, cardLink } from "../dashboard/DashboardGraphics";
import { BellIcon, ClipboardCheckIcon, ClipboardListIcon, FileTextIcon, TriangleAlertIcon } from "@/components/icons";
import { usePortalCapas, usePortalHome, usePortalNcrs } from "../../hooks/usePortal";
import { ChangeApprovalList } from "./PortalChangeApprovalPage";
import { PpapList } from "./PortalPpapPage";
import { PpapPackageList } from "./PortalPpapPackagePage";
import { STAGES } from "../../lib/ncr";
import { PERIODS } from "../../lib/supplierPerformance";
import { describeApiError } from "../../lib/api-client";
import { dueWords, partyKindLabel, scarPath, scarStatus, sharedPath, shareKindLabel, shortDate } from "../../lib/portal";

/**
 * The portal's dashboard (the default page), laid out as a dashboard: a strip of figures across the top (what needs attention, what is open, what
 * is waiting), then the company's own numbers on the left (a supplier's performance as the organisation measures it, a customer's quality figures)
 * and, beside them, what needs the person's attention and where the open non-conformances stand. One period toggle serves every figure.
 */
export default function PortalDashboard() {
  const { access } = useOutletContext();
  const live = !access.mfaRequired;
  const supplier = access.partyKind === "supplier";
  const home = usePortalHome(live ? access.organisationId : undefined);
  const ncrs = usePortalNcrs(access.organisationId, { enabled: live });
  const capas = usePortalCapas(access.organisationId, { enabled: live && !supplier });
  const [days, setDays] = useState("90");
  const contact = access.contactName || access.organisationName;

  if (access.mfaRequired) {
    return (
      <Wide>
        <Callout tone="warning" title="Two-factor authentication needed" role="alert">
          {access.organisationName} asks everyone who signs in to its portal to use two-factor authentication.{" "}
          <Link to={`/mfa?next=${encodeURIComponent("/portal")}`} className="font-medium text-link-color hover:underline">Set it up or enter your code</Link> to continue.
        </Callout>
      </Wide>
    );
  }
  if (home.isLoading) return <Wide><LoadingScreen /></Wide>;
  if (home.error) return <Wide><Callout tone="error" role="alert">{describeApiError(home.error)}</Callout></Wide>;
  const d = home.data;
  const waitingScars = d.scarsAwaiting;
  const scarActions = d.scarsWithActions ?? [];
  const nothing = d.attention.length === 0 && waitingScars.length === 0 && scarActions.length === 0;
  const needing = new Set([...d.attention.map((i) => i.id), ...waitingScars.map((c) => c.id), ...scarActions.map((c) => c.id)]).size;
  const openNcs = (ncrs.data?.data ?? []).filter((n) => n.stage !== "closed" && n.stage !== "cancelled");
  const stageParts = STAGES.filter((st) => st.key !== "draft").map((st, i) => ({ key: st.key, label: st.label, count: openNcs.filter((n) => n.stage === st.key).length, color: `var(--chart-${i + 1})` })).filter((st) => st.key !== "closed" && st.key !== "cancelled");
  const running = (capas.data?.data ?? []).filter((c) => c.stage !== "closed" && c.stage !== "cancelled").length;
  const waitingCount = (d.toAcknowledge ?? 0) + (d.toConfirm ?? 0);

  return (
    <Wide>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <section aria-labelledby="portal-welcome" className="flex flex-col gap-1">
          <h1 id="portal-welcome" className="text-2xl font-semibold">{access.partyName}</h1>
          <p className="text-sm text-secondary-text">{partyKindLabel(access.partyKind)} portal for {access.organisationName}</p>
          <p className="text-sm text-primary-text">Your contact at {access.organisationName}: <span className="font-medium">{contact}</span></p>
        </section>
        <SlidingToggle ariaLabel="Period" options={PERIODS} value={days} onChange={setDays} />
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile icon={BellIcon} label="Needing attention" value={needing} alert={needing > 0} to="/portal/non-conformances?s.attention=1" note={needing === 0 ? "Nothing waiting for you" : "New, replied to or waiting for you"} />
        <StatTile icon={TriangleAlertIcon} label="Open non-conformances" value={openNcs.length} to="/portal/non-conformances" note="Shared with you and not yet closed" />
        {supplier ? (
          <StatTile icon={ClipboardCheckIcon} label="Corrective actions waiting" value={new Set([...waitingScars, ...scarActions].map((c) => c.id)).size} alert={waitingScars.length > 0} to="/portal/scars" note="Needing a response or with actions to do" />
        ) : (
          <StatTile icon={ClipboardListIcon} label="8Ds in progress" value={running} to="/portal/8ds" note="Shared with you and not yet closed" />
        )}
        <StatTile icon={FileTextIcon} label="To acknowledge or confirm" value={waitingCount} alert={waitingCount > 0} to="/portal/documents" note="Documents, alerts and closures" />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
          {supplier ? <PerformancePanel access={access} days={days} /> : <PortalFigures access={access} days={days} />}
        </div>
        <aside className="flex min-w-0 flex-col gap-4" aria-label="Your attention and open records">
          <section aria-labelledby="portal-attention" className="rounded-2xl border border-border-color bg-secondary-bg p-5">
            <h2 id="portal-attention" className="text-lg font-semibold">Needs your attention</h2>
            {d.attention.length === 0 ? (
              <p className="mt-1 text-sm text-secondary-text">
                {d.shared === 0 && nothing
                  ? `Nothing has been shared with you yet. When ${access.organisationName} shares a non-conformance or an 8D with you, it will appear here.`
                  : "Nothing new. You have seen everything shared with you and there are no new replies."}
              </p>
            ) : (
              <div className="max-h-96 overflow-y-auto">
                <SharedList items={d.attention} organisationId={access.organisationId} label="Needs your attention" />
              </div>
            )}
          </section>
          <ChangeApprovalList access={access} onlyWaiting heading="Changes waiting for your approval" />
          <PpapList access={access} onlyWaiting heading="Part approvals waiting for your answer" />
          <PpapPackageList access={access} onlyEditable heading="Part approval packages to prepare" />
          {waitingScars.length > 0 && (
            <section aria-labelledby="portal-scars-awaiting" className="rounded-2xl border border-warning-color/40 bg-secondary-bg p-5">
              <h2 id="portal-scars-awaiting" className="text-lg font-semibold">Waiting for your response</h2>
              <ScarList items={waitingScars} organisationId={access.organisationId} label="Requests waiting for your response" />
            </section>
          )}
          {scarActions.length > 0 && (
            <section aria-labelledby="portal-scar-actions" className="rounded-2xl border border-warning-color/40 bg-secondary-bg p-5">
              <h2 id="portal-scar-actions" className="text-lg font-semibold">Actions for you</h2>
              <ScarList items={scarActions} organisationId={access.organisationId} label="Requests with actions for you" />
            </section>
          )}
          <section aria-labelledby="portal-open-ncs" className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 id="portal-open-ncs" className="text-lg font-semibold">Open non-conformances</h2>
              <Link to="/portal/non-conformances" className={cardLink}>See all</Link>
            </div>
            {openNcs.length === 0 ? <Empty>No open non-conformances.</Empty> : <SplitBar parts={stageParts} label="Open non-conformances by stage" unit="non-conformance" columns={1} />}
          </section>
        </aside>
      </div>
    </Wide>
  );
}

/** The dashboard's own, wider column. */
const Wide = ({ children }) => <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">{children}</div>;

/** The shared records as a list: kind and reference, title, when, and what is new. */
export function SharedList({ items, organisationId, label }) {
  return (
    <ul aria-label={label} className="mt-2 flex flex-col divide-y divide-border-color rounded-xl border border-border-color">
      {items.map((i) => (
        <li key={i.id}>
          <Link to={sharedPath(i.id, organisationId)} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm hover:bg-primary-bg">
            <div className="min-w-0 grow">
              <p className="truncate font-medium text-primary-text">{i.reference} · {i.title}</p>
              <p className="text-xs text-secondary-text">{shareKindLabel(i.kind)} · shared {shortDate(i.sharedAt)} · {i.comments} {i.comments === 1 ? "comment" : "comments"}</p>
            </div>
            {i.needsClosure && <span className="rounded-full bg-warning-color/15 px-2 py-0.5 text-xs font-medium text-warning-color">Please confirm closure</span>}
            {i.needsAcknowledgement && <span className="rounded-full bg-warning-color/15 px-2 py-0.5 text-xs font-medium text-warning-color">Please acknowledge</span>}
            {!i.viewed && <span className="rounded-full bg-brand-primary/15 px-2 py-0.5 text-xs font-medium text-brand-primary">New</span>}
            {i.newComments > 0 && <span className="rounded-full bg-warning-color/15 px-2 py-0.5 text-xs font-medium text-warning-color">{i.newComments} new {i.newComments === 1 ? "reply" : "replies"}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Corrective action requests as a list: reference and title, what is asked of them, when it is due. */
export function ScarList({ items, organisationId, label }) {
  return (
    <ul aria-label={label} className="mt-2 flex flex-col divide-y divide-border-color rounded-xl border border-border-color">
      {items.map((c) => {
        const st = scarStatus(c.status);
        return (
          <li key={c.id}>
            <Link to={scarPath(c.id, organisationId)} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm hover:bg-primary-bg">
              <div className="min-w-0 grow">
                <p className="truncate font-medium text-primary-text">{c.reference} · {c.title}</p>
                <p className="text-xs text-secondary-text">{st.label}{dueWords(c) ? ` · ${dueWords(c)}` : ""}{c.extensionWaiting ? " · more time asked for" : ""}{c.openActions > 0 ? ` · ${c.openActions} ${c.openActions === 1 ? "action" : "actions"} to do` : ""}</p>
              </div>
              {(c.overdue || c.lateActions > 0) && <span className="rounded-full bg-error-color/15 px-2 py-0.5 text-xs font-medium text-error-color">{c.overdue ? "Overdue" : "Action overdue"}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
