/** Formatting shared by the operator panels. Amounts arrive as integer pence, excluding VAT unless a label says otherwise. */
export const pounds = (pence, currency = "GBP") =>
  pence === null || pence === undefined ? "—" : new Intl.NumberFormat("en-GB", { style: "currency", currency: String(currency).toUpperCase() }).format(pence / 100);

export const when = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
export const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");

/** "3 minutes ago" style, for how fresh something is. */
export const ago = (iso, now = Date.now()) => {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const units = [[86400, "day"], [3600, "hour"], [60, "minute"]];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
};

const TONES = {
  good: "bg-success-color/15 text-success-color",
  info: "bg-info-color/15 text-info-color",
  warn: "bg-warning-color/20 text-primary-text",
  bad: "bg-error-color/15 text-error-color",
  quiet: "bg-border-color text-secondary-text",
};
export const toneClass = (tone) => TONES[tone] ?? TONES.quiet;

/** Colour of a subscription or organisation status. */
export const statusTone = (status) =>
  ({ active: "good", trialing: "info", past_due: "warn", unpaid: "bad", incomplete: "warn", paused: "quiet", cancelled: "quiet", suspended: "bad", archived: "quiet", paid: "good", open: "warn", void: "quiet", uncollectible: "bad", failed: "bad", processed: "good", ignored: "quiet", received: "warn" })[status] ?? "quiet";

/** What a billing or organisation event says, in a sentence. */
export const describeEvent = ({ event, details = {} }) => {
  const plan = details.plan ? String(details.plan) : null;
  switch (event) {
    case "subscription_created": return `Subscription created${details.interval ? ` (${details.interval === "year" ? "annual" : "monthly"})` : ""}`;
    case "seats_added": return `Seats added${plan ? `: ${plan} ${details.from ?? "?"} → ${details.to ?? "?"}` : ""}`;
    case "seats_removed": return `Seats removed${plan ? `: ${plan} ${details.from ?? "?"} → ${details.to ?? "?"}` : ""}`;
    case "package_assigned": return `Package assigned${plan ? ` (${plan})` : ""}`;
    case "package_upgraded": return "Package upgraded";
    case "package_downgraded": return "Package downgraded";
    case "assignment_removed": return "A package was removed from someone";
    case "billing_interval_changed": return `Billing interval changed${details.from ? `: ${details.from} → ${details.to}` : ""}`;
    case "payment_failed": return "Payment failed";
    case "cancellation_requested": return "Cancellation requested (ends at the period end)";
    case "admin_override": return details.overAssigned ? `Stripe has fewer ${plan ?? ""} seats than are in use (${details.overAssigned} over)` : "Administrative change";
    case "organisation_started": return "Organisation started";
    case "setup_finished": return "Set-up finished";
    case "organisation_archived": return `Organisation archived${details.reason ? ` (${String(details.reason).replace("_", " ")})` : ""}`;
    default: return event.replaceAll("_", " ");
  }
};
