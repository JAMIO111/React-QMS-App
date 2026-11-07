import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import RHFComboBox from "../ui/RHFComboBox";
import OrganisationLogo from "../Settings/OrganisationLogo";
import RequireMfaSetting from "../Settings/RequireMfaSetting";
import SitesManager from "../Settings/SitesManager";
import ThemeColourPicker from "../Settings/ThemeColourPicker";
import TwoFactorCard from "../Settings/TwoFactorCard";
import { describeApiError } from "../../lib/api-client";
import { countryOptions } from "../../lib/onboarding";
import { useOrganisationDetails, usePermissions, useSites, useUpdateOrganisation } from "../../hooks/useQmsApi";
import { useStartCheckout, usePlanCatalogue, usePortalSession, useSubscriptionOverview } from "../../hooks/useSubscription";
import { useCheckoutReturn } from "../../hooks/useCheckoutReturn";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useToast } from "../../contexts/ToastProvider";
import { clearChoice, formatDate, loadChoice, money, saveChoice } from "../../lib/billing";
import CheckoutNotice from "../billing/CheckoutNotice";
import SeatPicker from "../billing/SeatPicker";
import TeamInvite from "./TeamInvite";
import { ErrorNotice, FormError, buttonClass } from "../master-data/shared";

/** Step 1: the organisation's name, and where the first site is. */
export const OrganisationStep = () => {
  const { data: org } = useOrganisationDetails();
  const sites = useSites();
  const update = useUpdateOrganisation();
  const [name, setName] = useState(org?.name ?? "");
  useEffect(() => setName(org?.name ?? ""), [org?.name]);
  const first = sites.data?.data?.[0] ?? sites.data?.items?.[0];
  const dirty = org && name.trim() !== org.name;
  return (
    <div className="flex flex-col gap-4">
      <MenuCard as="form" aria-label="Organisation name" title="Name" subtitle="Shown in the app and on your reports" bodyClassName="flex flex-col gap-3"
        onSubmit={(e) => { e.preventDefault(); if (dirty) update.mutate({ body: { name: name.trim() } }); }}>
        <Field label="Organisation name" required minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        <FormError error={update.error} />
        <div className="flex justify-end">
          <button type="submit" className={buttonClass.neutral} disabled={!dirty || update.isPending}>{update.isPending ? "Saving…" : "Save name"}</button>
        </div>
      </MenuCard>
      {first && (
        <p className="text-sm text-secondary-text">
          First site: <span className="text-primary-text">{first.name}</span> ({first.code}), time zone <span className="text-primary-text">{first.timezone}</span>. You can add sites and change this in the Sites step.
        </p>
      )}
    </div>
  );
};

/** The current subscription in one card, with the way to Stripe's portal. */
export const SubscriptionSummary = ({ overview, canManage }) => {
  const sub = overview.subscription;
  const portal = usePortalSession();
  const { showToast } = useToast();
  const openPortal = () =>
    portal.mutate(undefined, {
      onSuccess: ({ url }) => window.location.assign(url),
      onError: (e) => showToast({ type: "error", title: "Could not open billing", message: describeApiError(e) }),
    });
  return (
    <MenuCard title="Your subscription" subtitle={sub.status === "trialing" ? `Free trial until ${formatDate(sub.trialEnd)}` : `Status: ${sub.status.replace("_", " ")}`}>
      <div className="flex flex-col gap-3 text-sm text-primary-text">
        <ul className="flex flex-col gap-1">
          {overview.items.filter((i) => i.purchased > 0).map((i) => (
            <li key={i.planSlug}>{i.purchased} × {i.planName} ({money(i.unitAmount, sub.currency)} per user per {sub.billingInterval === "year" ? "year" : "month"})</li>
          ))}
        </ul>
        <p className="text-secondary-text">
          {sub.status === "trialing" ? `Your card is charged from ${formatDate(sub.trialEnd)}` : sub.currentPeriodEnd ? `Next billing date ${formatDate(sub.currentPeriodEnd)}` : ""}
          {sub.cancelAtPeriodEnd ? ". It is set to end then and not renew." : "."} Prices exclude VAT.
        </p>
        <p>The owner holds a Controller seat, so everything is available.</p>
        {canManage && sub.billingProvider === "stripe" && (
          <div>
            <button type="button" className={buttonClass.neutral} disabled={portal.isPending} onClick={openPortal}>
              {portal.isPending ? "Opening…" : "Manage billing"}
            </button>
          </div>
        )}
      </div>
    </MenuCard>
  );
};

/** Step 2: the plan. Choose seats, go to Stripe's checkout (14-day trial, card required), come back and the app opens. */
export const PlanStep = ({ state }) => {
  const { organisationId } = useOrganisation();
  const { can } = usePermissions();
  const overview = useSubscriptionOverview();
  const catalogue = usePlanCatalogue();
  const checkout = useCheckoutReturn();
  const start = useStartCheckout();
  const portal = usePortalSession();
  const { showToast } = useToast();
  const [choice, setChoice] = useState(() => loadChoice(organisationId));
  const update = (next) => {
    setChoice(next);
    saveChoice(organisationId, next);
  };
  const canManage = can("subscription.manage");
  const open = state.accessState === "open";
  const sub = overview.data?.subscription;
  // The saved choice has done its job once the subscription exists.
  useEffect(() => {
    if (checkout.phase === "done") clearChoice(organisationId);
  }, [checkout.phase, organisationId]);

  if (overview.isLoading || catalogue.isLoading) return <p className="text-sm text-secondary-text">Loading…</p>;
  if (overview.error || catalogue.error) return <ErrorNotice error={overview.error ?? catalogue.error} />;
  const data = overview.data;
  const hasSubscription = !!sub && (open || sub.billingProvider === "stripe" || sub.status !== "cancelled");

  const checkoutNow = () =>
    start.mutate(
      { interval: choice.interval, seats: Object.fromEntries(Object.entries(choice.seats).filter(([, q]) => q > 0)), returnTo: "setup" },
      { onSuccess: ({ url }) => window.location.assign(url) },
    );
  const openPortal = () =>
    portal.mutate(undefined, {
      onSuccess: ({ url }) => window.location.assign(url),
      onError: (e) => showToast({ type: "error", title: "Could not open billing", message: describeApiError(e) }),
    });

  return (
    <div className="flex flex-col gap-4">
      <CheckoutNotice checkout={checkout} />
      {open && sub ? (
        <SubscriptionSummary overview={data} canManage={canManage} />
      ) : (
        <MenuCard
          title={hasSubscription ? "Your subscription needs attention" : "Choose your seats"}
          subtitle={state.billingRequired ? "A subscription is needed before you can use Fortress QMS" : "Choose your plan when you are ready"}>
          <div className="flex flex-col gap-4 text-sm text-primary-text">
            {hasSubscription ? (
              <>
                <p>
                  Your subscription is {sub.status.replace("_", " ")}, or no owner holds a Controller seat. Fix the payment in Stripe's billing portal and everything comes back at once.
                </p>
                {canManage && sub.billingProvider === "stripe" && (
                  <div>
                    <button type="button" className={buttonClass.primary} disabled={portal.isPending} onClick={openPortal}>
                      {portal.isPending ? "Opening…" : "Manage billing"}
                    </button>
                  </div>
                )}
              </>
            ) : !data.checkoutAvailable ? (
              <>
                <p>Online payment is not switched on for this server yet, so a subscription cannot be started here. {state.billingRequired ? "Everything except billing and set-up stays locked until it can." : ""}</p>
                <p>
                  <Link to="/Settings/Subscription" className="text-link-color underline">Open Subscription &amp; billing</Link>
                </p>
              </>
            ) : (
              <>
                <p>
                  Fortress QMS is priced per seat: Observer (read only), Contributor (record and complete work) and Controller (full functionality). You need at least one <strong>Controller</strong> seat, and you, the owner, take it.
                </p>
                {canManage ? (
                  <>
                    <SeatPicker plans={catalogue.data.plans} value={choice} onChange={update} disabled={start.isPending} />
                    <FormError error={start.error} />
                    <div className="flex justify-end">
                      <button type="button" className={buttonClass.primary} disabled={start.isPending} onClick={checkoutNow}>
                        {start.isPending ? "Opening checkout…" : "Continue to secure checkout"}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="text-secondary-text">Only an owner or administrator can start the subscription.</p>
                )}
              </>
            )}
          </div>
        </MenuCard>
      )}
    </div>
  );
};

/** Step 3: legal name, country, logo and colour. */
export const DetailsStep = () => {
  const { data: org } = useOrganisationDetails();
  const update = useUpdateOrganisation();
  const [legalName, setLegalName] = useState(org?.legalName ?? "");
  const [country, setCountry] = useState(org?.country ?? null);
  // Follow the saved values, but not the moment they first load as "nothing": that would wipe what the person has already started typing.
  const savedLegalName = org?.legalName ?? "";
  const savedCountry = org?.country ?? null;
  useEffect(() => { setLegalName(savedLegalName); setCountry(savedCountry); }, [savedLegalName, savedCountry]);
  const dirty = org && (legalName.trim() !== (org.legalName ?? "") || (country ?? null) !== (org.country ?? null));
  return (
    <div className="flex flex-col gap-4">
      <MenuCard as="form" aria-label="Legal details" title="Legal details" subtitle="Used on documents and invoices" bodyClassName="flex flex-col gap-3 min-h-[16rem]"
        onSubmit={(e) => { e.preventDefault(); if (dirty) update.mutate({ body: { legalName: legalName.trim() || null, country } }); }}>
        <Field label="Legal name" maxLength={200} value={legalName} onChange={(e) => setLegalName(e.target.value)} hint="e.g. Acme Fabrication Limited" />
        <RHFComboBox label="Country" value={country} onChange={(v) => setCountry(v ?? null)} options={countryOptions()} placeholder="Choose a country" clearable />
        <FormError error={update.error} />
        <div className="flex justify-end">
          <button type="submit" className={buttonClass.neutral} disabled={!dirty || update.isPending}>{update.isPending ? "Saving…" : "Save details"}</button>
        </div>
      </MenuCard>
      <OrganisationLogo logoPath={org?.settings.logoPath ?? null} canManage />
      <ThemeColourPicker value={org?.settings.themeColour ?? "purple"} canManage />
    </div>
  );
};

/** Step 4: sites and their departments (the same manager as Settings → Organisation). */
export const SitesStep = () => <SitesManager canManage />;

/** Step 5: two-factor authentication for everyone, and for the owner. */
export const SecurityStep = () => {
  const { data: org } = useOrganisationDetails();
  return (
    <div className="flex flex-col gap-4">
      <TwoFactorCard />
      <RequireMfaSetting value={!!org?.settings.requireMfa} canManage />
    </div>
  );
};

/** Step 6: the team. Paste addresses, choose role, departments and package for each, see the seats left, send; the same tool as Settings → Users. */
export const TeamStep = () => <TeamInvite />;

const STATUS_TEXT = { done: "Done", skipped: "Skipped", pending: "Not done" };

/** Step 7: what is set up, what is not, and finishing. */
export const ReviewStep = ({ state, labelOf, error }) => (
  <div className="flex flex-col gap-4">
    <MenuCard title="Where things stand" subtitle={state.canFinish ? "Everything required is in place" : "Some required steps are still open"}>
      <ul aria-label="Set-up summary" className="flex flex-col divide-y divide-border-color">
        {state.steps.filter((s) => s.key !== "review").map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="text-primary-text">
              {labelOf(s.key)}
              {s.required && <span className="ml-2 text-xs text-secondary-text">required</span>}
            </span>
            <span className={s.status === "done" ? "text-success-color" : s.status === "skipped" ? "text-secondary-text" : s.required ? "font-medium text-error-color" : "text-secondary-text"}>{STATUS_TEXT[s.status]}</span>
          </li>
        ))}
      </ul>
    </MenuCard>
    {error && <p role="alert" className="text-sm text-error-color">{describeApiError(error)}</p>}
  </div>
);
