import { Link, useOutletContext } from "react-router-dom";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import { PortalFigures } from "./PortalComplaints";
import { PerformancePanel } from "./PortalPerformancePage";
import Content from "./portalContent";
import { usePortalHome } from "../../hooks/usePortal";
import { describeApiError } from "../../lib/api-client";
import { dueWords, partyKindLabel, scarPath, scarStatus, sharedPath, shareKindLabel, shortDate } from "../../lib/portal";

/**
 * The portal's dashboard (the default page): what needs the person's attention first, then how their company is doing: a supplier's performance as the
 * organisation measures it, a customer's quality figures. Everything else (registers, complaints, team) is a menu item of its own.
 */
export default function PortalDashboard() {
  const { access } = useOutletContext();
  const home = usePortalHome(access.mfaRequired ? undefined : access.organisationId);
  const contact = access.contactName || access.organisationName;

  if (access.mfaRequired) {
    return (
      <Content>
        <Callout tone="warning" title="Two-factor authentication needed" role="alert">
          {access.organisationName} asks everyone who signs in to its portal to use two-factor authentication.{" "}
          <Link to={`/mfa?next=${encodeURIComponent("/portal")}`} className="font-medium text-link-color hover:underline">Set it up or enter your code</Link> to continue.
        </Callout>
      </Content>
    );
  }
  if (home.isLoading) return <Content><LoadingScreen /></Content>;
  if (home.error) return <Content><Callout tone="error" role="alert">{describeApiError(home.error)}</Callout></Content>;
  const d = home.data;
  const nothing = d.attention.length === 0 && d.scarsAwaiting.length === 0 && (d.scarsWithActions ?? []).length === 0;

  return (
    <Content>
      <section aria-labelledby="portal-welcome" className="flex flex-col gap-1 rounded-2xl border border-border-color bg-secondary-bg p-5">
        <h1 id="portal-welcome" className="text-xl font-semibold">{access.partyName}</h1>
        <p className="text-sm text-secondary-text">{partyKindLabel(access.partyKind)} portal for {access.organisationName}</p>
        <p className="text-sm text-primary-text">Your contact at {access.organisationName}: <span className="font-medium">{contact}</span></p>
      </section>

      {d.scarsAwaiting.length > 0 && (
        <section aria-labelledby="portal-scars-awaiting" className="rounded-2xl border border-warning-color/40 bg-secondary-bg p-5">
          <h2 id="portal-scars-awaiting" className="text-lg font-semibold">Waiting for your response</h2>
          <ScarList items={d.scarsAwaiting} organisationId={access.organisationId} label="Requests waiting for your response" />
        </section>
      )}
      {(d.scarsWithActions ?? []).length > 0 && (
        <section aria-labelledby="portal-scar-actions" className="rounded-2xl border border-warning-color/40 bg-secondary-bg p-5">
          <h2 id="portal-scar-actions" className="text-lg font-semibold">Actions for you</h2>
          <ScarList items={d.scarsWithActions} organisationId={access.organisationId} label="Requests with actions for you" />
        </section>
      )}
      <section aria-labelledby="portal-attention" className="rounded-2xl border border-border-color bg-secondary-bg p-5">
        <h2 id="portal-attention" className="text-lg font-semibold">Needs your attention</h2>
        {d.attention.length === 0 ? (
          <p className="mt-1 text-sm text-secondary-text">
            {d.shared === 0 && nothing
              ? `Nothing has been shared with you yet. When ${access.organisationName} shares a non-conformance or an 8D with you, it will appear here.`
              : "Nothing new. You have seen everything shared with you and there are no new replies."}
          </p>
        ) : (
          <SharedList items={d.attention} organisationId={access.organisationId} label="Needs your attention" />
        )}
      </section>

      {access.partyKind === "supplier" && <PerformancePanel access={access} />}
      {access.partyKind === "customer" && <PortalFigures access={access} />}
    </Content>
  );
}

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
