import { useState } from "react";
import MenuCard from "../ui/MenuCard";
import LoadingScreen from "../ui/LoadingScreen";
import LoadingButton from "../ui/LoadingButton";
import Switch from "@/components/ui/Switch";
import { ApiUnavailable } from "./SettingsOrganisation";
import { CheckIcon, XIcon } from "@/components/icons";
import { describeApiError } from "../../lib/api-client";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import {
  useInvoices,
  usePlanCatalogue,
  useSeatAssignments,
  useSubscriptionMutation,
  useSubscriptionOverview,
} from "../../hooks/useSubscription";

const button =
  "rounded-lg border border-border-color px-2 py-1 text-sm text-primary-text hover:border-border-dark-color disabled:opacity-50 cursor-pointer";
const select =
  "rounded-lg border border-border-color bg-text-input-color px-2 py-1 text-sm text-primary-text disabled:opacity-60";

const STATUS_STYLES = {
  active: "bg-green-500/15 text-green-700 dark:text-green-300",
  trialing: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  past_due: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  unpaid: "bg-red-500/15 text-red-700 dark:text-red-300",
  paused: "bg-gray-500/15 text-secondary-text",
  cancelled: "bg-gray-500/15 text-secondary-text",
  incomplete: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};
const LEVEL_LABELS = { none: "—", view: "View", operational: "Operational", full: "Full" };

/** Prices arrive as integer pence. */
const money = (pence, currency = "GBP") =>
  pence === null || pence === undefined
    ? "—"
    : new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(pence / 100);

const date = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const displayName = (m) => [m.firstName, m.surname].filter(Boolean).join(" ") || m.email || "Unknown";
const unit = (interval) => (interval === "year" ? "year" : "month");

const StatusBadge = ({ status }) => (
  <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[status] ?? STATUS_STYLES.paused}`}>
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

const Overview = ({ overview }) => {
  const { subscription: sub, items, totals } = overview;
  const currency = sub?.currency ?? "GBP";
  return (
    <MenuCard title="Subscription" subtitle="One subscription for the whole organisation; prices exclude VAT" action={sub && <StatusBadge status={sub.status} />}>
      {!sub && (
        <p className="text-sm text-secondary-text">
          No subscription yet. Buy seats below to create one.
        </p>
      )}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Estimated monthly cost" value={money(totals.monthlyEquivalent, currency)} hint={sub ? `Billed ${sub.billingInterval === "year" ? "annually" : "monthly"}` : undefined} />
        <Stat label="Annual cost" value={money(totals.annual, currency)} />
        <Stat label="Next billing date" value={sub?.currentPeriodEnd ? date(sub.currentPeriodEnd) : "—"} hint={sub?.cancelAtPeriodEnd ? "Cancels at period end" : undefined} />
        <Stat label="Seats assigned" value={`${totals.seatsAssigned} / ${totals.seatsPurchased}`} hint={`${totals.seatsAvailable} available`} />
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
              <tr key={i.planSlug} className="border-t border-border-color text-primary-text">
                <td className="py-2 pr-3">{i.planName}</td>
                <td className="py-2 pr-3">{i.purchased}</td>
                <td className="py-2 pr-3">{i.assigned}</td>
                <td className="py-2 pr-3">{i.available}</td>
                <td className="py-2">{money(i.unitAmount, currency)}/user/{unit(sub?.billingInterval)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sub?.status === "past_due" && (
        <p role="alert" className="mt-3 text-sm text-amber-700 dark:text-amber-300">
          Payment is overdue. Access continues for {sub.gracePeriodDays} days from {date(sub.pastDueSince)}.
        </p>
      )}
    </MenuCard>
  );
};

const PricingCards = ({ catalogue, overview, canManage }) => {
  const [annual, setAnnual] = useState(overview.subscription?.billingInterval === "year");
  const mutation = useSubscriptionMutation();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const seatsOf = (slug) => overview.items.find((i) => i.planSlug === slug);

  const buy = async (plan, delta) => {
    const current = seatsOf(plan.slug);
    const quantity = Math.max(0, (current?.purchased ?? 0) + delta);
    const price = annual ? plan.annual : plan.monthly;
    const ok = await confirm({
      title: `${delta > 0 ? "Add" : "Remove"} a ${plan.name} seat?`,
      message: `${plan.name} seats: ${current?.purchased ?? 0} → ${quantity}. Recurring cost changes by ${money(Math.abs(delta) * (price?.unitAmount ?? 0), price?.currency)} per ${annual ? "year" : "month"} (excluding VAT).`,
      confirmText: "Confirm",
      cancelText: "Cancel",
      type: "info",
    });
    if (!ok) return;
    mutation.mutate(
      { action: "seats", planSlug: plan.slug, quantity },
      {
        onSuccess: () => showToast({ type: "success", title: "Seats updated", message: `${plan.name}: ${quantity} seat${quantity === 1 ? "" : "s"}.` }),
        onError: (error) => showToast({ type: "error", title: "Not changed", message: describeApiError(error) }),
      },
    );
  };

  return (
    <MenuCard
      title="Packages"
      subtitle="Packages control what the product offers; company roles still control who may approve or release"
      action={
        <Switch checked={annual} onChange={(e) => setAnnual(e.target.checked)} aria-label="Annual billing">
          Annual billing
        </Switch>
      }>
      <div className="grid gap-4 md:grid-cols-3">
        {catalogue.plans.map((plan) => {
          const price = annual ? plan.annual : plan.monthly;
          const owned = seatsOf(plan.slug);
          return (
            <div key={plan.slug} aria-label={`${plan.name} package`} role="group" className="flex flex-col gap-2 rounded-xl border border-border-color p-4">
              <h3 className="text-base font-semibold text-primary-text">{plan.name}</h3>
              <p className="text-sm text-secondary-text">{plan.description}</p>
              <p className="text-2xl font-semibold text-primary-text">
                {money(annual ? plan.annualMonthlyEquivalent : plan.monthly?.unitAmount, price?.currency)}
                <span className="text-sm font-normal text-secondary-text"> /user/month</span>
              </p>
              {annual && plan.annualSaving > 0 && (
                <p className="text-xs text-green-700 dark:text-green-300">
                  Billed {money(plan.annual.unitAmount, plan.annual.currency)}/user/year — saves {money(plan.annualSaving, plan.annual.currency)}
                </p>
              )}
              <p className="text-sm text-secondary-text">
                {owned ? `${owned.purchased} purchased, ${owned.assigned} assigned` : "No seats purchased"}
              </p>
              {canManage && (
                <div className="mt-auto flex gap-2">
                  <LoadingButton className={button} loading={mutation.isPending} onClick={() => buy(plan, 1)}>
                    Add seat
                  </LoadingButton>
                  <LoadingButton className={button} disabled={!owned || owned.purchased <= owned.assigned} loading={mutation.isPending} onClick={() => buy(plan, -1)}>
                    Remove seat
                  </LoadingButton>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </MenuCard>
  );
};

const Comparison = ({ catalogue }) => (
  <MenuCard title="Package comparison" subtitle="Maximum functionality each package unlocks; company permissions still apply">
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-secondary-text">
            <th className="py-1 pr-3 font-medium">Module / feature</th>
            {catalogue.plans.map((p) => (
              <th key={p.slug} className="py-1 pr-3 font-medium">{p.name}</th>
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
        {m.status === "planned" && <span className="ml-2 text-xs text-tertiary-text">planned</span>}
      </td>
      {plans.map((p) => (
        <td key={p.slug} className="py-2 pr-3">{LEVEL_LABELS[p.levels[m.slug]] ?? "—"}</td>
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

  const priceOf = (slug) => overview.items.find((i) => i.planSlug === slug)?.unitAmount ?? null;
  const freeOf = (slug) => overview.items.find((i) => i.planSlug === slug)?.available ?? 0;

  const run = (vars, message) =>
    mutation.mutate(vars, {
      onSuccess: () => showToast({ type: "success", title: "Updated", message }),
      onError: (e) => showToast({ type: "error", title: "Not changed", message: describeApiError(e) }),
    });

  const change = async (member, planSlug) => {
    if (planSlug === "") {
      const ok = await confirm({
        title: `Remove ${displayName(member)}'s package?`,
        message: "They keep their membership and company roles but lose access to subscription features. Records are kept.",
        confirmText: "Remove package",
        cancelText: "Cancel",
        type: "warning",
      });
      if (ok) run({ action: "remove", membershipId: member.membershipId }, `${displayName(member)} no longer has a package.`);
      return;
    }
    const plan = catalogue.plans.find((p) => p.slug === planSlug);
    if (freeOf(planSlug) < 1) {
      showToast({ type: "error", title: "No free seat", message: `All ${plan.name} seats are in use. Buy another seat first.` });
      return;
    }
    const ok = await confirm({
      title: `Assign ${plan.name} to ${displayName(member)}?`,
      message: `This uses one ${plan.name} seat at ${money(priceOf(planSlug), currency)} per ${unit(interval)} (excluding VAT).${member.plan ? ` Their ${member.plan.name} seat is released.` : ""}`,
      confirmText: "Assign",
      cancelText: "Cancel",
      type: "info",
    });
    if (ok) run({ action: "assign", membershipId: member.membershipId, planSlug }, `${displayName(member)} now has ${plan.name}.`);
  };

  return (
    <MenuCard title="Seat allocation" subtitle="Company role and subscription package are separate">
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
            <tr key={m.membershipId} className="border-t border-border-color align-top text-primary-text">
              <td className="py-2 pr-3">
                <div className="font-medium">{displayName(m)}</div>
                {m.email && <div className="text-xs text-secondary-text">{m.email}</div>}
              </td>
              <td className="py-2 pr-3">{m.roles.length ? m.roles.join(", ") : <span className="text-tertiary-text">No role</span>}</td>
              <td className="py-2 pr-3">
                {canAssign ? (
                  <select
                    aria-label={`Package for ${displayName(m)}`}
                    className={select}
                    value={m.plan?.slug ?? ""}
                    disabled={mutation.isPending || m.status === "removed"}
                    onChange={(e) => change(m, e.target.value)}>
                    <option value="">No package</option>
                    {catalogue.plans.map((p) => (
                      <option key={p.slug} value={p.slug}>{p.name}</option>
                    ))}
                  </select>
                ) : (
                  m.plan?.name ?? <span className="text-tertiary-text">No package</span>
                )}
              </td>
              <td className="py-2">{m.unitAmount === null ? "—" : `${money(m.unitAmount, currency)}/${unit(interval)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </MenuCard>
  );
};

const INVOICE_STYLES = { paid: STATUS_STYLES.active, open: STATUS_STYLES.past_due, uncollectible: STATUS_STYLES.unpaid };

const Invoices = () => {
  const { data: invoices, isLoading, error } = useInvoices();
  return (
    <MenuCard title="Billing history" subtitle="Payment methods and billing details will be managed through the payment provider once it is connected">
      {isLoading && <LoadingScreen />}
      {error && <p role="alert" className="text-sm text-error-color">{describeApiError(error)}</p>}
      {invoices && invoices.length === 0 && <p className="text-sm text-secondary-text">No invoices yet.</p>}
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
              <tr key={i.id} className="border-t border-border-color text-primary-text">
                <td className="py-2 pr-3">{i.invoiceNumber ?? "—"}</td>
                <td className="py-2 pr-3">{date(i.invoiceDate)}</td>
                <td className="py-2 pr-3">{i.periodStart ? `${date(i.periodStart)} – ${date(i.periodEnd)}` : "—"}</td>
                <td className="py-2 pr-3">{money(i.taxAmount, i.currency)}</td>
                <td className="py-2 pr-3">{money(i.totalAmount, i.currency)}</td>
                <td className="py-2 pr-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${INVOICE_STYLES[i.status] ?? STATUS_STYLES.paused}`}>{i.status}</span>
                </td>
                <td className="py-2">
                  {i.invoicePdfUrl && (
                    <a className="text-brand-primary underline" href={i.invoicePdfUrl} target="_blank" rel="noreferrer">Download</a>
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

  if (overview.isLoading || catalogue.isLoading) return <LoadingScreen />;
  if (overview.error || catalogue.error) return <ApiUnavailable error={overview.error ?? catalogue.error} />;

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <Overview overview={overview.data} />
      <PricingCards catalogue={catalogue.data} overview={overview.data} canManage={can("subscription.manage")} />
      <Seats catalogue={catalogue.data} overview={overview.data} canAssign={can("subscription.seats")} />
      <Comparison catalogue={catalogue.data} />
      {can("invoices.read") && <Invoices />}
    </div>
  );
};

export default SettingsSubscription;
