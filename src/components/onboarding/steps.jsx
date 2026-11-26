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
import { countryOptions, loadTeamDraft, seatsForDraft } from "../../lib/onboarding";
import { useOrganisationDetails, usePermissions, useUpdateOrganisation } from "../../hooks/useQmsApi";
import { useStartCheckout, usePlanCatalogue, usePortalSession, useSubscriptionOverview } from "../../hooks/useSubscription";
import { useCheckoutReturn } from "../../hooks/useCheckoutReturn";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useToast } from "../../contexts/ToastProvider";
import { DEFAULT_CHOICE, clearChoice, formatDate, hasSavedChoice, loadChoice, money, saveChoice } from "../../lib/billing";
import CheckoutNotice from "../billing/CheckoutNotice";
import SeatPicker from "../billing/SeatPicker";
import TeamInvite from "./TeamInvite";
import { ErrorNotice, FormError } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";

/**
 * Step 1: everything about the organisation itself on one page: name (needed), legal name and country, logo and colour (all optional). The wizard's
 * Continue saves what is typed (through `saveRef`) and marks the optional details as done.
 */
export const OrganisationStep = ({ saveRef }) => {
  const { data: org } = useOrganisationDetails();
  const update = useUpdateOrganisation();
  const [name, setName] = useState(org?.name ?? "");
  const [legalName, setLegalName] = useState(org?.legalName ?? "");
  const [country, setCountry] = useState(org?.country ?? null);
  // Follow the saved values, but never overwrite what is being typed or what is still saving (the details go back only if the save is refused).
  const keepTyped = update.isPending || update.isError;
  const savedName = org?.name ?? "";
  const savedLegalName = org?.legalName ?? "";
  const savedCountry = org?.country ?? null;
  useEffect(() => { if (!keepTyped) setName(savedName); }, [savedName, keepTyped]);
  useEffect(() => { if (!keepTyped) setLegalName(savedLegalName); }, [savedLegalName, keepTyped]);
  useEffect(() => { if (!keepTyped) setCountry(savedCountry); }, [savedCountry, keepTyped]);
  const dirty = !!org && (name.trim() !== savedName || legalName.trim() !== savedLegalName || (country ?? null) !== savedCountry);
  const nameOk = name.trim().length >= 2;
  const save = () => {
    if (!nameOk) return false;
    if (dirty) update.mutate({ body: { name: name.trim(), legalName: legalName.trim() || null, country } });
    return true;
  };
  if (saveRef) saveRef.current = save;
  return (
    <div className="flex flex-col gap-4">
      <MenuCard as="form" aria-label="Organisation details" title="Name and legal details" subtitle="The name is shown in the app and on your reports. The legal name and country are used on documents and invoices." bodyClassName="flex flex-col gap-3"
        onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Field label="Organisation name" required minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Legal name" maxLength={200} value={legalName} onChange={(e) => setLegalName(e.target.value)} hint="e.g. Acme Fabrication Limited" />
          <RHFComboBox label="Country" value={country} onChange={(v) => setCountry(v ?? null)} options={countryOptions()} placeholder="Choose a country" clearable />
        </div>
        <FormError error={update.error} />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-secondary-text">{dirty ? "Not saved yet. Continue saves it for you." : "All changes saved."}</span>
          <CTAButton buttonType="submit" type="neutral" size="md" disabled={!dirty || !nameOk}>Save details</CTAButton>
        </div>
      </MenuCard>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <OrganisationLogo logoPath={org?.settings.logoPath ?? null} canManage />
        <ThemeColourPicker value={org?.settings.themeColour ?? "purple"} canManage />
      </div>
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
            <CTAButton buttonType="button" type="neutral" size="md" disabled={portal.isPending} loading={portal.isPending} onClick={openPortal}>
              {portal.isPending ? "Opening…" : "Manage billing"}
            </CTAButton>
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
  // Start from the team that was planned (its seats, plus the owner's Controller seat), unless a choice was already made on the way to Stripe and back.
  const [draft] = useState(() => loadTeamDraft(organisationId));
  const [choice, setChoice] = useState(() => (!hasSavedChoice(organisationId) && draft.rows.length > 0 ? { ...DEFAULT_CHOICE, seats: seatsForDraft(draft.rows) } : loadChoice(organisationId)));
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
      {open && draft.rows.length > 0 && (
        <Callout tone="success" title="Your plan is active" action={<CTAButton to="/setup/team" type="main" size="md">Send the invitations</CTAButton>}>
          {draft.rows.length} {draft.rows.length === 1 ? "person is" : "people are"} waiting to be invited. Check the list and send when you are ready.
        </Callout>
      )}
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
                    <CTAButton buttonType="button" type="main" size="lg" disabled={portal.isPending} loading={portal.isPending} onClick={openPortal}>
                      {portal.isPending ? "Opening…" : "Manage billing"}
                    </CTAButton>
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
                {draft.rows.length > 0 && (
                  <Callout tone="info">We have suggested seats for the {draft.rows.length} {draft.rows.length === 1 ? "person" : "people"} on your team plan, plus your own Controller seat. Change them freely.</Callout>
                )}
                <p>
                  Fortress QMS is priced per seat: Observer (read only), Contributor (record and complete work) and Controller (full functionality). You need at least one <strong>Controller</strong> seat, and you, the owner, take it.
                </p>
                {canManage ? (
                  <>
                    <SeatPicker plans={catalogue.data.plans} value={choice} onChange={update} disabled={start.isPending} />
                    <FormError error={start.error} />
                    <div className="flex justify-end">
                      <CTAButton buttonType="button" type="main" size="lg" disabled={start.isPending} loading={start.isPending} onClick={checkoutNow}>
                        {start.isPending ? "Opening checkout…" : "Continue to secure checkout"}
                      </CTAButton>
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

/** Sites and their departments (the same manager as Settings → Organisation). */
export const SitesStep = () => <SitesManager canManage />;

/** Two-factor authentication for everyone, and for the owner. */
export const SecurityStep = () => {
  const { data: org } = useOrganisationDetails();
  return (
    <div className="flex flex-col gap-4">
      <TwoFactorCard />
      <RequireMfaSetting value={!!org?.settings.requireMfa} canManage />
    </div>
  );
};

/** The team: before the plan is active a plan for who to invite (kept here, nobody is emailed); once it is active the invitations can be sent. */
export const TeamStep = ({ state }) => <TeamInvite live={state.accessState === "open"} />;
