import Callout from "../ui/Callout";
import { feePlans, feeTotal, freeObserverLimit, money, observerProblem, recurringTotal, seatCount, seatPlans, trialEnd, formatDate, unitPrice, TRIAL_DAYS } from "../../lib/billing";

const stepButton =
  "flex h-8 w-8 items-center justify-center rounded-lg border border-border-color text-primary-text hover:border-border-dark-color disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer";

/**
 * Chooses billing interval and seats per package before Stripe Checkout. `value` = { interval, seats: { planSlug: quantity } }.
 * Controller needs at least one seat (the owner takes it). `plans` is the whole catalogue: seat packages get a card each, the organisation fee
 * (kind `fee`) is shown once under them and counted in the total. Observers are free up to twice the paid seats. Prices exclude VAT, which Stripe
 * adds at checkout.
 */
const SeatPicker = ({ plans, value, onChange, disabled = false, minimum = { controller: 1 }, trial = true }) => {
  const { interval, seats } = value;
  const set = (patch) => onChange({ ...value, ...patch });
  const step = (slug, delta) => set({ seats: { ...seats, [slug]: Math.max(minimum[slug] ?? 0, (seats[slug] ?? 0) + delta) } });
  const total = recurringTotal(plans, value);
  const perMonthWhenAnnual = interval === "year" ? Math.round(total / 12) : null;
  const fees = feePlans(plans);
  const fee = feeTotal(plans, interval);
  const saving = interval === "year" ? plans.reduce((t, p) => t + (p.kind === "fee" ? 1 : seats[p.slug] ?? 0) * (p.annualSaving ?? 0), 0) : 0;
  const observerLimit = freeObserverLimit(seats);
  const tooManyObservers = observerProblem(seats);

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-wrap items-center gap-2" disabled={disabled}>
        <legend className="mb-1 text-sm font-medium text-primary-text">Billing</legend>
        {[
          { key: "month", label: "Monthly" },
          { key: "year", label: "Annual" },
        ].map((o) => (
          <label
            key={o.key}
            className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${interval === o.key ? "border-brand-primary bg-brand-primary/10 text-primary-text" : "border-border-color text-secondary-text"}`}>
            <input type="radio" name="billing-interval" className="accent-current" checked={interval === o.key} onChange={() => set({ interval: o.key })} />
            {o.label}
            {o.key === "year" && <span className="text-xs text-success-color">2 months free</span>}
          </label>
        ))}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        {seatPlans(plans).map((plan) => {
          const qty = seats[plan.slug] ?? 0;
          const price = unitPrice(plan, interval);
          const required = (minimum[plan.slug] ?? 0) > 0;
          const free = price === 0;
          const atLimit = plan.slug === "observer" && free && qty >= observerLimit;
          return (
            <div key={plan.slug} role="group" aria-label={`${plan.name} package`} className="flex flex-col gap-2 rounded-xl border border-border-color p-3">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-base font-semibold text-primary-text">{plan.name}</h3>
                {required && <span className="text-xs text-secondary-text">at least {minimum[plan.slug]}</span>}
              </div>
              <p className="text-sm text-secondary-text">{plan.description}</p>
              {free ? (
                <p className="text-lg font-semibold text-primary-text">
                  Free
                  {plan.slug === "observer" && <span className="text-sm font-normal text-secondary-text"> up to twice your paid seats ({observerLimit})</span>}
                </p>
              ) : (
                <p className="text-lg font-semibold text-primary-text">
                  {money(price, plan.monthly?.currency)}
                  <span className="text-sm font-normal text-secondary-text"> /user/{interval === "year" ? "year" : "month"}</span>
                </p>
              )}
              <div className="mt-auto flex items-center gap-3">
                <button type="button" className={stepButton} aria-label={`Remove ${plan.name} seat`} disabled={disabled || qty <= (minimum[plan.slug] ?? 0)} onClick={() => step(plan.slug, -1)}>
                  −
                </button>
                <span aria-live="polite" aria-label={`${plan.name} seats`} className="min-w-6 text-center text-primary-text">
                  {qty}
                </span>
                <button type="button" className={stepButton} aria-label={`Add ${plan.name} seat`} disabled={disabled || qty >= 10000 || atLimit} onClick={() => step(plan.slug, 1)}>
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {fees.map((f) => (
        <div key={f.slug} role="group" aria-label={`${f.name} fee`} className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl border border-dashed border-border-color px-3 py-2 text-sm">
          <span className="text-primary-text">
            <strong>{f.name} fee</strong>
            <span className="text-secondary-text"> — {f.description ?? "one per organisation, whatever the number of seats"}</span>
          </span>
          <span className="font-semibold text-primary-text">
            {money(unitPrice(f, interval), f.monthly?.currency)}
            <span className="font-normal text-secondary-text"> /{interval === "year" ? "year" : "month"}</span>
          </span>
        </div>
      ))}

      {tooManyObservers && <Callout tone="warning">{tooManyObservers}</Callout>}

      <div role="status" className="flex flex-col gap-1 rounded-xl border border-border-color bg-primary-bg/50 p-3 text-sm text-primary-text">
        {trial ? (
          <p>
            <strong>{money(0)} today.</strong> Your {TRIAL_DAYS}-day free trial starts now and ends on {formatDate(trialEnd())}. Cancel any time before then and you pay nothing.
          </p>
        ) : (
          <p>
            <strong>{money(total)}</strong> is invoiced now for {seatCount(seats)} seat{seatCount(seats) === 1 ? "" : "s"}{fee > 0 ? " and the organisation fee" : ""}, plus VAT where it applies, and again each {interval === "year" ? "year" : "month"}.
            {perMonthWhenAnnual !== null && <span className="text-secondary-text"> ({money(perMonthWhenAnnual)} a month on average{saving > 0 ? `, saving ${money(saving)} a year` : ""}.)</span>}
          </p>
        )}
        {trial && (
          <p>
            Then <strong>{money(total)}</strong> per {interval === "year" ? "year" : "month"} for {seatCount(seats)} seat{seatCount(seats) === 1 ? "" : "s"}{fee > 0 ? " and the organisation fee" : ""}, plus VAT where it applies.
            {perMonthWhenAnnual !== null && <span className="text-secondary-text"> ({money(perMonthWhenAnnual)} a month on average{saving > 0 ? `, saving ${money(saving)} a year` : ""}.)</span>}
          </p>
        )}
        <p className="text-xs text-secondary-text">{trial ? "Payment is taken securely by Stripe. We never see your card details." : "Payment is handled by Stripe. We never see your card details if you pay by card."}</p>
      </div>
    </div>
  );
};

export default SeatPicker;
