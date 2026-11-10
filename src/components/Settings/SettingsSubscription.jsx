import { useState } from "react";
import CheckoutNotice from "../billing/CheckoutNotice";
import SeatPicker from "../billing/SeatPicker";
import ComboField from "../ui/ComboField";
import MenuCard from "../ui/MenuCard";
import LoadingScreen from "../ui/LoadingScreen";
import LoadingButton from "../ui/LoadingButton";
import Switch from "@/components/ui/Switch";
import { ApiUnavailable } from "./SettingsOrganisation";
import { CheckIcon, XIcon } from "@/components/icons";
import { describeApiError } from "../../lib/api-client";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useToast } from "../../contexts/ToastProvider";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useCheckoutReturn } from "../../hooks/useCheckoutReturn";
import { formatDate, loadChoice, money, saveChoice } from "../../lib/billing";
import {
  useChangeSeats,
  useInvoices,
  usePlanCatalogue,
  usePortalSession,
  useSeatAssignments,
  useSeatPreview,
  useStartCheckout,
  useSubscriptionMutation,
  useSubscriptionOverview,
} from "../../hooks/useSubscription";
import CTAButton from "@/components/CTAButton";

const STATUS_STYLES = {
  active: "bg-green-500/15 text-green-700 dark:text-green-300",
  trialing: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  past_due: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  unpaid: "bg-red-500/15 text-red-700 dark:text-red-300",
  paused: "bg-gray-500/15 text-secondary-text",
  cancelled: "bg-gray-500/15 text-secondary-text",
  incomplete: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};
const LEVEL_LABELS = {
  none: "—",
  view: "View",
  operational: "Operational",
  full: "Full",
};

const date = formatDate;
const displayName = (m) =>
  [m.firstName, m.surname].filter(Boolean).join(" ") || m.email || "Unknown";
const unit = (interval) => (interval === "year" ? "year" : "month");

const StatusBadge = ({ status }) => (
  <span
    className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[status] ?? STATUS_STYLES.paused}`}>
    {status.replace("_", " ")}
  </span>
);

const Stat = ({ label, value, hint }) => (
  <div className="flex flex-col">
    <span className="text-xs text-tertiary-text">{label}</span>
    <span className="text-xl font-semibold text-primary-text">{value}</span>
    {hint && <span className="text-xs text-secondary-text">{hint}</span>}
  </div>
);

const ManageBillingButton = ({ className = "px-2 py-1" }) => {
  const portal = usePortalSession();
  const { showToast } = useToast();
  return (
    <CTAButton
      type="neutral"
      size="md"
      className={className}
      disabled={portal.isPending} loading={portal.isPending}
      onClick={() =>
        portal.mutate(undefined, {
          onSuccess: ({ url }) => window.location.assign(url),
          onError: (e) =>
            showToast({
              type: "error",
              title: "Could not open billing",
              message: describeApiError(e),
            }),
        })
      }>
      {portal.isPending ? "Opening…" : "Manage billing"}
    </CTAButton>
  );
};

const Overview = ({ overview, canManage }) => {
  const { subscription: sub, items, totals } = overview;
  const currency = sub?.currency ?? "GBP";
  const stripe = sub?.billingProvider === "stripe";
  return (
    <MenuCard
      title="Subscription"
      subtitle="One subscription for the whole organisation; prices exclude VAT"
      action={
        <div className="flex items-center gap-2">
          {canManage && stripe && <ManageBillingButton />}
          {sub && <StatusBadge status={sub.status} />}
        </div>
      }>
      {sub?.status === "trialing" && (
        <p role="status" className="mb-3 text-sm text-primary-text">
          Free trial until {date(sub.trialEnd)}. Your card is charged from then
          {sub.cancelAtPeriodEnd
            ? ", unless you cancel, which you have"
            : ", unless you cancel before"}
          .
        </p>
      )}
      {sub?.cancelAtPeriodEnd && sub.status !== "cancelled" && (
        <p
          role="alert"
          className="mb-3 text-sm text-amber-700 dark:text-amber-300">
          This subscription is set to end on {date(sub.currentPeriodEnd)}. After
          that the organisation is locked to billing until it is renewed.
        </p>
      )}
      {sub?.status === "cancelled" && (
        <p
          role="alert"
          className="mb-3 text-sm text-amber-700 dark:text-amber-300">
          This subscription has been cancelled
          {sub.currentPeriodEnd
            ? `; access continues until ${date(sub.currentPeriodEnd)}`
            : ""}
          .
        </p>
      )}
      {!sub && (
        <p className="text-sm text-secondary-text">
          No subscription yet.{" "}
          {overview.checkoutAvailable
            ? "Choose your seats below to start one."
            : "Buy seats below to create one."}
        </p>
      )}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          label="Estimated monthly cost"
          value={money(totals.monthlyEquivalent, currency)}
          hint={
            sub
              ? `Billed ${sub.billingInterval === "year" ? "annually" : "monthly"}`
              : undefined
          }
        />
        <Stat label="Annual cost" value={money(totals.annual, currency)} />
        <Stat
          label="Next billing date"
          value={sub?.currentPeriodEnd ? date(sub.currentPeriodEnd) : "—"}
          hint={sub?.cancelAtPeriodEnd ? "Cancels at period end" : undefined}
        />
        <Stat
          label="Seats assigned"
          value={`${totals.seatsAssigned} / ${totals.seatsPurchased}`}
          hint={`${totals.seatsAvailable} available`}
        />
      </div>
      {items.length > 0 && (
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left text-secondary-text">
              <th className="py-1 pr-3 font-medium">Package</th>
              <th className="py-1 pr-3 font-medium">Purchased</th>
              <th className="py-1 pr-3 font-medium">Assigned</th>
              <th className="py-1 pr-3 font-medium">Available</th>
              <th className="py-1 font-medium">Unit price</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr
                key={i.planSlug}
                className="border-t border-border-color text-primary-text">
                <td className="py-2 pr-3">{i.planName}</td>
                <td className="py-2 pr-3">{i.purchased}</td>
                <td className="py-2 pr-3">{i.assigned}</td>
                <td className="py-2 pr-3">{i.available}</td>
                <td className="py-2">
                  {money(i.unitAmount, currency)}/user/
                  {unit(sub?.billingInterval)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sub?.status === "past_due" && (
        <p
          role="alert"
          className="mt-3 text-sm text-amber-700 dark:text-amber-300">
          Payment is overdue. Access continues for {sub.gracePeriodDays} days
          from {date(sub.pastDueSince)}.
        </p>
      )}
    </MenuCard>
  );
};

const PricingCards = ({ catalogue, overview, canManage }) => {
  const managed =
    overview.providerManaged &&
    overview.subscription?.billingProvider === "stripe";
  // With Stripe the billing interval is fixed by the subscription; it can be changed in the billing portal only.
  const [annual, setAnnual] = useState(
    overview.subscription?.billingInterval === "year",
  );
  const [draft, setDraft] = useState({});
  const manual = useSubscriptionMutation();
  const preview = useSeatPreview();
  const change = useChangeSeats();
  const mutation = managed ? change : manual;
  const confirm = useConfirm();
  const { showToast } = useToast();
  const seatsOf = (slug) => overview.items.find((i) => i.planSlug === slug);
  const purchased = (slug) => seatsOf(slug)?.purchased ?? 0;
  const wanted = (slug) => draft[slug] ?? purchased(slug);
  const changes = catalogue.plans.filter(
    (p) => wanted(p.slug) !== purchased(p.slug),
  );

  const step = (plan, delta) => {
    const min = Math.max(
      seatsOf(plan.slug)?.assigned ?? 0,
      managed && plan.slug === "controller" ? 1 : 0,
    );
    const next = Math.max(min, wanted(plan.slug) + delta);
    setDraft((d) => ({ ...d, [plan.slug]: next }));
  };

  const costChange = changes.reduce((t, p) => {
    const price = annual ? p.annual : p.monthly;
    return t + (wanted(p.slug) - purchased(p.slug)) * (price?.unitAmount ?? 0);
  }, 0);

  const applyManaged = async () => {
    const lines = changes
      .map((p) => `${p.name}: ${purchased(p.slug)} → ${wanted(p.slug)}`)
      .join("; ");
    const seats = Object.fromEntries(
      changes.map((p) => [p.slug, wanted(p.slug)]),
    );
    try {
      const quote = await preview.mutateAsync({ seats });
      const due = quote.amountDue;
      const ok = await confirm({
        title: "Apply seat changes?",
        message: `${lines}. ${due > 0 ? `Stripe charges ${money(due, quote.currency.toUpperCase())} now for the rest of this period (prorated, ${money(quote.tax, quote.currency.toUpperCase())} of it VAT)` : due < 0 ? `Stripe credits ${money(-due, quote.currency.toUpperCase())} to your next invoice` : "Nothing is charged now"}. From the next billing date the recurring cost changes by ${costChange < 0 ? "-" : ""}${money(Math.abs(costChange))} per ${annual ? "year" : "month"} (excluding VAT).`,
        confirmText: "Apply",
        cancelText: "Cancel",
        type: "info",
      });
      if (!ok) return;
      await change.mutateAsync({ seats });
      setDraft({});
      showToast({ type: "success", title: "Seats updated", message: lines });
    } catch (error) {
      showToast({
        type: "error",
        title: "Not changed",
        message: describeApiError(error),
      });
    }
  };

  const apply = async () => {
    if (managed) return applyManaged();
    const lines = changes
      .map((p) => `${p.name}: ${purchased(p.slug)} → ${wanted(p.slug)}`)
      .join("; ");
    const ok = await confirm({
      title: "Apply seat changes?",
      message: `${lines}. Recurring cost changes by ${costChange < 0 ? "-" : ""}${money(Math.abs(costChange))} per ${annual ? "year" : "month"} (excluding VAT).`,
      confirmText: "Apply",
      cancelText: "Cancel",
      type: "info",
    });
    if (!ok) return;
    try {
      for (const p of changes) {
        await mutation.mutateAsync({
          action: "seats",
          planSlug: p.slug,
          quantity: wanted(p.slug),
        });
      }
      setDraft({});
      showToast({ type: "success", title: "Seats updated", message: lines });
    } catch (error) {
      showToast({
        type: "error",
        title: "Not changed",
        message: describeApiError(error),
      });
    }
  };

  return (
    <MenuCard
      title="Packages"
      subtitle="Packages control what the product offers; company roles still control who may approve or release"
      action={
        managed ? (
          <span className="text-sm text-secondary-text">
            Billed {annual ? "annually" : "monthly"}
          </span>
        ) : (
          <Switch
            checked={annual}
            onChange={(e) => setAnnual(e.target.checked)}
            aria-label="Annual billing">
            Annual billing
          </Switch>
        )
      }>
      <div className="grid gap-4 md:grid-cols-3">
        {catalogue.plans.map((plan) => {
          const price = annual ? plan.annual : plan.monthly;
          const owned = seatsOf(plan.slug);
          const qty = wanted(plan.slug);
          return (
            <div
              key={plan.slug}
              aria-label={`${plan.name} package`}
              role="group"
              className="flex flex-col gap-2 rounded-xl bg-primary-bg border border-border-color p-4">
              <h3 className="text-base font-semibold text-primary-text">
                {plan.name}
              </h3>
              <p className="text-sm text-secondary-text">{plan.description}</p>
              <p className="text-2xl font-semibold text-primary-text">
                {money(
                  annual
                    ? plan.annualMonthlyEquivalent
                    : plan.monthly?.unitAmount,
                  price?.currency,
                )}
                <span className="text-sm font-normal text-secondary-text">
                  {" "}
                  /user/month
                </span>
              </p>
              {annual && plan.annualSaving > 0 && (
                <p className="text-xs text-green-700 dark:text-green-300">
                  Billed {money(plan.annual.unitAmount, plan.annual.currency)}
                  /user/year — saves{" "}
                  {money(plan.annualSaving, plan.annual.currency)}
                </p>
              )}
              <p className="text-sm text-secondary-text">
                {owned?.assigned ?? 0} assigned
              </p>
              {canManage && (
                <div className="mt-auto flex items-center gap-3">
                  <CTAButton
                    buttonType="button"
                    aria-label={`Remove ${plan.name} seat`}
                    type="neutral" size="md" className="w-8 px-2 py-1"
                    disabled={
                      mutation.isPending ||
                      preview.isPending ||
                      qty <=
                        Math.max(
                          owned?.assigned ?? 0,
                          managed && plan.slug === "controller" ? 1 : 0,
                        )
                    } loading={mutation.isPending || preview.isPending}
                    onClick={() => step(plan, -1)}>
                    −
                  </CTAButton>
                  <span
                    aria-label={`${plan.name} seats`}
                    className="min-w-6 text-center text-primary-text">
                    {qty}
                  </span>
                  <CTAButton
                    buttonType="button"
                    aria-label={`Add ${plan.name} seat`}
                    type="neutral" size="md" className="w-8 px-2 py-1"
                    disabled={mutation.isPending} loading={mutation.isPending}
                    onClick={() => step(plan, 1)}>
                    +
                  </CTAButton>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {canManage && changes.length > 0 && (
        <div className="mt-4 flex items-center justify-end gap-2">
          <CTAButton
            buttonType="button"
            type="neutral" size="md" className="px-2 py-1"
            disabled={mutation.isPending} loading={mutation.isPending}
            onClick={() => setDraft({})}>
            Discard
          </CTAButton>
          <LoadingButton
            variant="main"
          className="px-2 py-1"
            loading={mutation.isPending || preview.isPending}
            loadingText={managed ? "Checking the price…" : "Applying…"}
            onClick={apply}>
            Apply changes
          </LoadingButton>
        </div>
      )}
    </MenuCard>
  );
};

/** For an organisation with no subscription yet, when Stripe is set up: choose seats and go to the secure checkout. */
const StartSubscription = ({ catalogue }) => {
  const { organisationId } = useOrganisation();
  const [choice, setChoice] = useState(() => loadChoice(organisationId));
  const start = useStartCheckout();
  const { showToast } = useToast();
  const update = (next) => {
    setChoice(next);
    saveChoice(organisationId, next);
  };
  const go = () =>
    start.mutate(
      {
        interval: choice.interval,
        seats: Object.fromEntries(
          Object.entries(choice.seats).filter(([, q]) => q > 0),
        ),
        returnTo: "settings",
      },
      {
        onSuccess: ({ url }) => window.location.assign(url),
        onError: (e) =>
          showToast({
            type: "error",
            title: "Could not start checkout",
            message: describeApiError(e),
          }),
      },
    );
  return (
    <MenuCard
      title="Start your subscription"
      subtitle="14-day free trial, card required, cancel any time before it ends">
      <SeatPicker
        plans={catalogue.plans}
        value={choice}
        onChange={update}
        disabled={start.isPending}
      />
      <div className="mt-4 flex justify-end">
        <LoadingButton
          variant="main"
          className="px-2 py-1"
          loading={start.isPending}
          loadingText="Opening checkout…"
          onClick={go}>
          Continue to secure checkout
        </LoadingButton>
      </div>
    </MenuCard>
  );
};

const Comparison = ({ catalogue }) => (
  <MenuCard
    title="Package comparison"
    subtitle="Maximum functionality each package unlocks; company permissions still apply">
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-secondary-text">
            <th className="py-1 pr-3 font-medium">Module / feature</th>
            {catalogue.plans.map((p) => (
              <th key={p.slug} className="py-1 pr-3 font-medium">
                {p.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {catalogue.modules.map((m) => (
            <ModuleRows key={m.slug} module={m} plans={catalogue.plans} />
          ))}
        </tbody>
      </table>
    </div>
  </MenuCard>
);

const ModuleRows = ({ module: m, plans }) => (
  <>
    <tr className="border-t border-border-color bg-primary-bg/40 text-primary-text">
      <td className="py-2 pr-3 font-medium">
        {m.name}
        {m.status === "planned" && (
          <span className="ml-2 text-xs text-tertiary-text">planned</span>
        )}
      </td>
      {plans.map((p) => (
        <td key={p.slug} className="py-2 pr-3">
          {LEVEL_LABELS[p.levels[m.slug]] ?? "—"}
        </td>
      ))}
    </tr>
    {m.features.map((f) => (
      <tr key={f.slug} className="text-secondary-text">
        <td className="py-1 pl-4 pr-3">{f.name}</td>
        {plans.map((p) => (
          <td key={p.slug} className="py-1 pr-3">
            {f.includedIn.includes(p.slug) ? (
              <CheckIcon aria-label="Included" className="text-green-600" />
            ) : (
              <XIcon aria-label="Not included" className="text-tertiary-text" />
            )}
          </td>
        ))}
      </tr>
    ))}
  </>
);

const Seats = ({ catalogue, overview, canAssign }) => {
  const { data: members, isLoading, error } = useSeatAssignments();
  const mutation = useSubscriptionMutation();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const interval = overview.subscription?.billingInterval ?? "month";
  const currency = overview.subscription?.currency ?? "GBP";

  if (isLoading) return <LoadingScreen />;
  if (error) return <ApiUnavailable error={error} />;

  const priceOf = (slug) =>
    overview.items.find((i) => i.planSlug === slug)?.unitAmount ?? null;
  const freeOf = (slug) =>
    overview.items.find((i) => i.planSlug === slug)?.available ?? 0;

  const run = (vars, message) =>
    mutation.mutate(vars, {
      onSuccess: () =>
        showToast({ type: "success", title: "Updated", message }),
      onError: (e) =>
        showToast({
          type: "error",
          title: "Not changed",
          message: describeApiError(e),
        }),
    });

  const change = async (member, planSlug) => {
    if (planSlug === "") {
      const ok = await confirm({
        title: `Remove ${displayName(member)}'s package?`,
        message:
          "They keep their membership and company roles but lose access to subscription features. Records are kept.",
        confirmText: "Remove package",
        cancelText: "Cancel",
        type: "warning",
      });
      if (ok)
        run(
          { action: "remove", membershipId: member.membershipId },
          `${displayName(member)} no longer has a package.`,
        );
      return;
    }
    const plan = catalogue.plans.find((p) => p.slug === planSlug);
    if (freeOf(planSlug) < 1) {
      showToast({
        type: "error",
        title: "No free seat",
        message: `All ${plan.name} seats are in use. Buy another seat first.`,
      });
      return;
    }
    const ok = await confirm({
      title: `Assign ${plan.name} to ${displayName(member)}?`,
      message: `This uses one ${plan.name} seat at ${money(priceOf(planSlug), currency)} per ${unit(interval)} (excluding VAT).${member.plan ? ` Their ${member.plan.name} seat is released.` : ""}`,
      confirmText: "Assign",
      cancelText: "Cancel",
      type: "info",
    });
    if (ok)
      run(
        { action: "assign", membershipId: member.membershipId, planSlug },
        `${displayName(member)} now has ${plan.name}.`,
      );
  };

  return (
    <MenuCard
      title="Seat allocation"
      subtitle="Company role and subscription package are separate">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-secondary-text">
            <th className="py-1 pr-3 font-medium">Employee</th>
            <th className="py-1 pr-3 font-medium">Company role</th>
            <th className="py-1 pr-3 font-medium">Subscription package</th>
            <th className="py-1 font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr
              key={m.membershipId}
              className="border-t border-border-color align-top text-primary-text">
              <td className="py-2 pr-3">
                <div className="font-medium">{displayName(m)}</div>
                {m.email && (
                  <div className="text-xs text-secondary-text">{m.email}</div>
                )}
              </td>
              <td className="py-2 pr-3">
                {m.roles.length ? (
                  m.roles.join(", ")
                ) : (
                  <span className="text-tertiary-text">No role</span>
                )}
              </td>
              <td className="py-2 pr-3">
                {canAssign ? (
                  <ComboField
                    label={`Package for ${displayName(m)}`}
                    value={m.plan?.slug ?? null}
                    disabled={mutation.isPending || m.status === "removed"}
                    onChange={(v) => (v ?? "") !== (m.plan?.slug ?? "") && change(m, v ?? "")}
                    placeholder="No package"
                    clearable
                    options={catalogue.plans.map((p) => ({ value: p.slug, label: p.name, hint: `${freeOf(p.slug)} free` }))}
                    className="min-w-44 [&_label]:sr-only"
                  />
                ) : (
                  (m.plan?.name ?? (
                    <span className="text-tertiary-text">No package</span>
                  ))
                )}
              </td>
              <td className="py-2">
                {m.unitAmount === null
                  ? "—"
                  : `${money(m.unitAmount, currency)}/${unit(interval)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </MenuCard>
  );
};

const INVOICE_STYLES = {
  paid: STATUS_STYLES.active,
  open: STATUS_STYLES.past_due,
  uncollectible: STATUS_STYLES.unpaid,
};

const Invoices = ({ managed, canManage }) => {
  const { data: invoices, isLoading, error } = useInvoices();
  return (
    <MenuCard
      title="Billing history"
      subtitle={
        managed
          ? "Payment method, billing details and tax number are managed in Stripe's secure portal"
          : "Payment methods and billing details are managed through the payment provider"
      }
      action={managed && canManage && <ManageBillingButton />}>
      {isLoading && <LoadingScreen />}
      {error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(error)}
        </p>
      )}
      {invoices && invoices.length === 0 && (
        <p className="text-sm text-secondary-text">No invoices yet.</p>
      )}
      {invoices && invoices.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-secondary-text">
              <th className="py-1 pr-3 font-medium">Invoice</th>
              <th className="py-1 pr-3 font-medium">Date</th>
              <th className="py-1 pr-3 font-medium">Period</th>
              <th className="py-1 pr-3 font-medium">VAT</th>
              <th className="py-1 pr-3 font-medium">Total</th>
              <th className="py-1 pr-3 font-medium">Status</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr
                key={i.id}
                className="border-t border-border-color text-primary-text">
                <td className="py-2 pr-3">{i.invoiceNumber ?? "—"}</td>
                <td className="py-2 pr-3">{date(i.invoiceDate)}</td>
                <td className="py-2 pr-3">
                  {i.periodStart
                    ? `${date(i.periodStart)} – ${date(i.periodEnd)}`
                    : "—"}
                </td>
                <td className="py-2 pr-3">{money(i.taxAmount, i.currency)}</td>
                <td className="py-2 pr-3">
                  {money(i.totalAmount, i.currency)}
                </td>
                <td className="py-2 pr-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${INVOICE_STYLES[i.status] ?? STATUS_STYLES.paused}`}>
                    {i.status}
                  </span>
                </td>
                <td className="py-2">
                  {i.invoicePdfUrl && (
                    <a
                      className="text-brand-primary underline"
                      href={i.invoicePdfUrl}
                      target="_blank"
                      rel="noreferrer">
                      Download
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </MenuCard>
  );
};

const SettingsSubscription = () => {
  const { can } = usePermissions();
  const overview = useSubscriptionOverview();
  const catalogue = usePlanCatalogue();
  const checkout = useCheckoutReturn();

  if (overview.isLoading || catalogue.isLoading) return <LoadingScreen />;
  if (overview.error || catalogue.error)
    return <ApiUnavailable error={overview.error ?? catalogue.error} />;
  const canManage = can("subscription.manage");
  const data = overview.data;
  const starting = !data.subscription && data.checkoutAvailable && canManage;

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <CheckoutNotice checkout={checkout} />
      <Overview overview={data} canManage={canManage} />
      {starting ? (
        <StartSubscription catalogue={catalogue.data} />
      ) : (
        <PricingCards
          catalogue={catalogue.data}
          overview={data}
          canManage={canManage}
        />
      )}
      <Seats
        catalogue={catalogue.data}
        overview={overview.data}
        canAssign={can("subscription.seats")}
      />
      <Comparison catalogue={catalogue.data} />
      {can("invoices.read") && (
        <Invoices
          managed={data.subscription?.billingProvider === "stripe"}
          canManage={canManage}
        />
      )}
    </div>
  );
};

export default SettingsSubscription;
