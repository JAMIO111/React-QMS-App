import { money, recurringTotal, seatCount, trialEnd, formatDate, unitPrice, TRIAL_DAYS } from "../../lib/billing";

const stepButton =
  "flex h-8 w-8 items-center justify-center rounded-lg border border-border-color text-primary-text hover:border-border-dark-color disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer";

/**
 * Chooses billing interval and seats per package before Stripe Checkout. `value` = { interval, seats: { planSlug: quantity } }.
 * Controller needs at least one seat (the owner takes it). Prices exclude VAT, which Stripe adds at checkout.
 */
const SeatPicker = ({ plans, value, onChange, disabled = false, minimum = { controller: 1 } }) => {
  const { interval, seats } = value;
  const set = (patch) => onChange({ ...value, ...patch });
  const step = (slug, delta) => set({ seats: { ...seats, [slug]: Math.max(minimum[slug] ?? 0, (seats[slug] ?? 0) + delta) } });
  const total = recurringTotal(plans, value);
  const perMonthWhenAnnual = interval === "year" ? Math.round(total / 12) : null;
  const saving = interval === "year" ? plans.reduce((t, p) => t + (seats[p.slug] ?? 0) * (p.annualSaving ?? 0), 0) : 0;

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

      <div className="grid gap-3 md:grid-cols-3">
        {plans.map((plan) => {
          const qty = seats[plan.slug] ?? 0;
          const price = unitPrice(plan, interval);
          const required = (minimum[plan.slug] ?? 0) > 0;
          return (
            <div key={plan.slug} role="group" aria-label={`${plan.name} package`} className="flex flex-col gap-2 rounded-xl border border-border-color p-3">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-base font-semibold text-primary-text">{plan.name}</h3>
                {required && <span className="text-xs text-secondary-text">at least {minimum[plan.slug]}</span>}
              </div>
              <p className="text-sm text-secondary-text">{plan.description}</p>
              <p className="text-lg font-semibold text-primary-text">
                {money(price, plan.monthly?.currency)}
                <span className="text-sm font-normal text-secondary-text"> /user/{interval === "year" ? "year" : "month"}</span>
              </p>
              <div className="mt-auto flex items-center gap-3">
                <button type="button" className={stepButton} aria-label={`Remove ${plan.name} seat`} disabled={disabled || qty <= (minimum[plan.slug] ?? 0)} onClick={() => step(plan.slug, -1)}>
                  −
                </button>
                <span aria-live="polite" aria-label={`${plan.name} seats`} className="min-w-6 text-center text-primary-text">
                  {qty}
                </span>
                <button type="button" className={stepButton} aria-label={`Add ${plan.name} seat`} disabled={disabled || qty >= 10000} onClick={() => step(plan.slug, 1)}>
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div role="status" className="flex flex-col gap-1 rounded-xl border border-border-color bg-primary-bg/50 p-3 text-sm text-primary-text">
        <p>
          <strong>{money(0)} today.</strong> Your {TRIAL_DAYS}-day free trial starts now and ends on {formatDate(trialEnd())}. Cancel any time before then and you pay nothing.
        </p>
        <p>
          Then <strong>{money(total)}</strong> per {interval === "year" ? "year" : "month"} for {seatCount(seats)} seat{seatCount(seats) === 1 ? "" : "s"}, plus VAT where it applies.
          {perMonthWhenAnnual !== null && <span className="text-secondary-text"> ({money(perMonthWhenAnnual)} a month on average{saving > 0 ? `, saving ${money(saving)} a year` : ""}.)</span>}
        </p>
        <p className="text-xs text-secondary-text">Payment is taken securely by Stripe. We never see your card details.</p>
      </div>
    </div>
  );
};

export default SeatPicker;
