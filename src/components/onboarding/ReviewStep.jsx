import { Link } from "react-router-dom";
import { BuildingIcon, CheckIcon, CircleAlertIcon, CreditCardIcon, MapPinIcon, PencilIcon, RocketIcon, ShieldCheckIcon, UsersIcon } from "@/components/icons";
import Callout from "../ui/Callout";
import { describeApiError } from "../../lib/api-client";
import { countryName, loadTeamDraft, pageStatus, seatsForDraft } from "../../lib/onboarding";
import { THEME_COLOURS } from "../../lib/theme-colours";
import { formatDate, money } from "../../lib/billing";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useAllDepartments, useMembers, useOrganisationDetails, usePermissions, useSites } from "../../hooks/useQmsApi";
import { useSubscriptionOverview } from "../../hooks/useSubscription";

/** How a card stands: the words always say it, the colour only helps. */
const TONES = {
  ready: { label: "Ready", cls: "bg-success-color/15 text-success-color border-success-color/40" },
  skipped: { label: "Skipped", cls: "bg-secondary-bg text-secondary-text border-border-color" },
  waiting: { label: "Waiting to send", cls: "bg-info-color/15 text-info-color border-info-color/40" },
  open: { label: "Not decided", cls: "bg-warning-color/15 text-warning-color border-warning-color/40" },
  needs: { label: "Needs attention", cls: "bg-error-color/15 text-error-color border-error-color/40" },
};

const Pill = ({ tone, children }) => {
  const t = TONES[tone];
  return <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${t.cls}`}>{children ?? t.label}</span>;
};

const Fact = ({ label, children }) => (
  <div className="flex flex-col gap-0.5 min-w-0">
    <dt className="text-xs text-secondary-text">{label}</dt>
    <dd className="truncate text-sm font-medium text-primary-text">{children}</dd>
  </div>
);

const SummaryCard = ({ icon: Icon, title, tone, pill, to, children, editLabel = "Change" }) => (
  <li className="list-none">
    <section aria-label={title} className="flex h-full flex-col gap-3 rounded-2xl border border-border-color bg-primary-bg p-4">
      <header className="flex items-start gap-3">
        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-primary/10 text-brand-primary">
          <Icon className="h-5 w-5" />
        </span>
        <h3 className="mt-1.5 min-w-0 flex-1 truncate text-base font-semibold text-primary-text">{title}</h3>
        <Pill tone={tone}>{pill}</Pill>
      </header>
      <div className="flex-1">{children}</div>
      <Link to={to} className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-link-color hover:underline" aria-label={`${editLabel} ${title.toLowerCase()}`}>
        <PencilIcon className="h-3.5 w-3.5" aria-hidden="true" /> {editLabel}
      </Link>
    </section>
  </li>
);

/** A ring that fills as the cards become ready; the number is also in words beside it. */
const ProgressRing = ({ done, total }) => {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="relative h-20 w-20 shrink-0" role="img" aria-label={`${done} of ${total} areas complete`}>
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
        <circle cx="40" cy="40" r={radius} fill="none" strokeWidth="7" className="stroke-primary-text/15" />
        <circle cx="40" cy="40" r={radius} fill="none" strokeWidth="7" strokeLinecap="round" className="stroke-brand-primary transition-[stroke-dashoffset] duration-700"
          strokeDasharray={circumference} strokeDashoffset={circumference * (1 - (total ? done / total : 0))} />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-lg font-bold text-primary-text">{done}/{total}</span>
    </div>
  );
};

/**
 * The last step: everything that was set up in one place, what still needs a decision, and what happens when the owner finishes. Each card reads
 * the real records (not the step marks alone) and links back to the step that changes it.
 */
const ReviewStep = ({ state, error }) => {
  const { organisationId } = useOrganisation();
  const { can } = usePermissions();
  const org = useOrganisationDetails().data;
  const sites = (useSites().data?.data ?? []).filter((s) => s.active !== false);
  const departments = (useAllDepartments().data?.data ?? []).filter((d) => d.active !== false);
  const open = state.accessState === "open";
  const members = useMembers({ enabled: open && can("members.read") }).data?.data ?? [];
  const overview = useSubscriptionOverview().data;
  const draft = loadTeamDraft(organisationId);

  const orgStatus = pageStatus(state, "organisation");
  const securityStatus = pageStatus(state, "security");
  const teamStatus = pageStatus(state, "team");
  const sub = overview?.subscription;
  const planOk = open && !!sub;

  const colour = THEME_COLOURS.find((c) => c.value === (org?.settings.themeColour ?? "purple"));
  const pending = members.filter((m) => m.status === "invited");
  const joined = members.filter((m) => m.status === "active");
  const needs = draft.rows.length > 0 ? seatsForDraft(draft.rows) : null;

  const siteTone = sites.length > 0 ? "ready" : "needs";
  const securityTone = securityStatus.status === "done" ? "ready" : securityStatus.status === "skipped" ? "skipped" : "open";
  const teamTone = pending.length + joined.length > 1 ? "ready" : draft.rows.length > 0 ? "waiting" : teamStatus.status === "skipped" ? "skipped" : "open";
  const planTone = planOk ? "ready" : state.billingRequired ? "needs" : "open";
  const orgTone = orgStatus.status === "done" ? "ready" : "needs";

  const tones = [orgTone, siteTone, securityTone, teamTone, planTone];
  // Only what is really done counts: a skipped step or a team that is only planned is not complete yet.
  const readyCount = tones.filter((t) => t === "ready").length;
  const attention = [
    orgTone === "needs" && { label: "Your organisation", to: "/setup/organisation" },
    siteTone === "needs" && { label: "Add a site", to: "/setup/sites" },
    planTone === "needs" && { label: "Choose your plan", to: "/setup/plan" },
  ].filter(Boolean);
  const finishable = state.canFinish;

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Progress" className="flex flex-wrap items-center gap-5 rounded-2xl border border-theme bg-theme-dark/20 p-5">
        <ProgressRing done={readyCount} total={tones.length} />
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-xl font-semibold text-primary-text">
            {finishable ? <RocketIcon className="h-6 w-6 text-brand-primary" aria-hidden="true" /> : <CircleAlertIcon className="h-6 w-6 text-warning-color" aria-hidden="true" />}
            {finishable ? `${org?.name ?? "Your organisation"} is ready to go` : "Nearly there"}
          </h3>
          <p className="mt-1 text-sm text-primary-text/80">
            {finishable
              ? "Everything needed is in place. Anything marked as not decided can wait: you can come back to it from the dashboard or Settings."
              : "A few required things are still open. Open each one below, then come back here."}
          </p>
          {!finishable && attention.length > 0 && (
            <ul aria-label="Still needed" className="mt-3 flex flex-wrap gap-2">
              {attention.map((a) => (
                <li key={a.to}>
                  <Link to={a.to} className="inline-flex items-center gap-1.5 rounded-full border border-error-color/40 bg-error-color/10 px-3 py-1 text-xs font-semibold text-error-color hover:bg-error-color/20">
                    {a.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <ul aria-label="Set-up summary" className="grid grid-cols-1 gap-4 p-0 lg:grid-cols-2">
        <SummaryCard icon={BuildingIcon} title="Organisation" tone={orgTone} to="/setup/organisation">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Fact label="Name">{org?.name ?? "—"}</Fact>
            <Fact label="Legal name">{org?.legalName || <span className="text-secondary-text">Not given</span>}</Fact>
            <Fact label="Country">{org?.country ? countryName(org.country) : <span className="text-secondary-text">Not given</span>}</Fact>
            <Fact label="Logo and colour">
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className={`h-3.5 w-3.5 rounded-full ${colour?.swatch ?? "bg-violet-600"}`} />
                {colour?.label ?? "Purple"}, {org?.settings.logoPath ? "logo added" : "no logo yet"}
              </span>
            </Fact>
          </dl>
        </SummaryCard>

        <SummaryCard icon={MapPinIcon} title="Sites and departments" tone={siteTone} to="/setup/sites">
          {sites.length === 0 ? (
            <p className="text-sm text-secondary-text">No site yet. Add the place where work happens.</p>
          ) : (
            <ul aria-label="Sites" className="flex flex-col gap-2 p-0">
              {sites.map((site) => {
                const own = departments.filter((d) => d.siteId === site.id);
                return (
                  <li key={site.id} className="list-none text-sm">
                    <span className="font-mono font-semibold text-primary-text">{site.code}</span> <span className="text-primary-text">{site.name}</span>
                    <span className="text-secondary-text"> · {own.length === 0 ? "no departments yet" : `${own.length} department${own.length === 1 ? "" : "s"}: ${own.map((d) => d.name).join(", ")}`}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </SummaryCard>

        <SummaryCard icon={ShieldCheckIcon} title="Security" tone={securityTone} pill={securityTone === "open" ? "Not decided" : undefined} to="/setup/security">
          <dl className="grid grid-cols-1 gap-3">
            <Fact label="Two-factor sign-in for everyone">{org?.settings.requireMfa ? "Required" : "Not required"}</Fact>
          </dl>
          <p className="mt-2 text-xs text-secondary-text">You can tighten this later in Settings → Security, including company sign-in and allowed networks.</p>
        </SummaryCard>

        <SummaryCard icon={UsersIcon} title="Your team" tone={teamTone} to="/setup/team" editLabel={draft.rows.length > 0 ? "Review the list" : "Change"}>
          {draft.rows.length > 0 ? (
            <>
              <p className="text-sm text-primary-text"><strong>{draft.rows.length}</strong> {draft.rows.length === 1 ? "person is" : "people are"} planned and {open ? "ready to invite" : "will be invited once your plan is active"}.</p>
              {needs && <p className="mt-1 text-xs text-secondary-text">Seats: Controller {needs.controller}, Contributor {needs.contributor}, Observer {needs.observer}.</p>}
            </>
          ) : open && pending.length + joined.length > 1 ? (
            <dl className="grid grid-cols-2 gap-3">
              <Fact label="Invited">{pending.length}</Fact>
              <Fact label="Joined">{Math.max(0, joined.length - 1)}</Fact>
            </dl>
          ) : (
            <p className="text-sm text-secondary-text">Nobody invited yet. You can invite people at any time from Settings → Users &amp; permissions.</p>
          )}
        </SummaryCard>

        <SummaryCard icon={CreditCardIcon} title="Plan and seats" tone={planTone} pill={planTone === "needs" ? "Not started" : undefined} to="/setup/plan">
          {planOk ? (
            <>
              <p className="text-sm text-primary-text">{sub.paymentRoute === "invoice" ? `Pay by invoice, payable within ${sub.paymentTermsDays ?? 14} days` : sub.status === "trialing" ? `Free trial until ${formatDate(sub.trialEnd)}` : `Status: ${sub.status.replace("_", " ")}`}</p>
              <ul aria-label="Seats" className="mt-1 flex flex-col gap-0.5 p-0 text-sm text-primary-text">
                {overview.items.filter((i) => i.purchased > 0).map((i) => (
                  <li key={i.planSlug} className="list-none">{i.purchased} × {i.planName} <span className="text-secondary-text">({money(i.unitAmount, sub.currency)} per user per {sub.billingInterval === "year" ? "year" : "month"})</span></li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-secondary-text">{state.billingRequired ? "Choose your seats and how to pay to start. Fortress QMS stays locked until you do." : "Choose your plan when you are ready."}</p>
          )}
        </SummaryCard>

        <li className="list-none">
          <section aria-label="What happens next" className="flex h-full flex-col gap-3 rounded-2xl border border-border-color bg-primary-bg p-4">
            <h3 className="text-base font-semibold text-primary-text">What happens next</h3>
            <ol className="flex flex-col gap-3 p-0 text-sm text-primary-text">
              {[
                ["Your dashboard opens", "A short go-live checklist shows what is left, such as inviting people and recording your first non-conformance."],
                draft.rows.length > 0 && open
                  ? ["Your invitations are waiting", `${draft.rows.length} ${draft.rows.length === 1 ? "person is" : "people are"} ready to invite. Send them from the Your team step.`]
                  : ["Bring your people in", "Invite colleagues from Settings → Users & permissions and give each a role and a seat."],
                ["Bring in your data", "Add parts, machines and suppliers by hand, or import them from a spreadsheet in Settings → Integrations."],
              ].map(([title, text], i) => (
                <li key={title} className="flex list-none gap-3">
                  <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-primary/15 text-xs font-bold text-brand-primary">{i + 1}</span>
                  <span><strong>{title}.</strong> <span className="text-secondary-text">{text}</span></span>
                </li>
              ))}
            </ol>
            <p className="mt-auto flex items-center gap-1.5 text-xs text-secondary-text"><CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> Nothing here is final: every choice can be changed in Settings.</p>
          </section>
        </li>
      </ul>

      {error && <Callout tone="error" role="alert">{describeApiError(error)}</Callout>}
    </div>
  );
};

export default ReviewStep;
