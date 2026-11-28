/** The go-live checklist (docs/onboarding-plan.md §16): what each item says and where to do it. Order and required flags come from the database. */
export const GO_LIVE_ITEMS = {
  subscription: { label: "Start your subscription", link: "/Settings/Subscription" },
  site: { label: "Add a site", link: "/Settings/Organisation" },
  departments: { label: "Add a department", link: "/Settings/Organisation" },
  invited: { label: "Invite someone else", link: "/Settings/Users" },
  details: { label: "Add your legal name and country", link: "/Settings/Organisation" },
  logo: { label: "Upload your logo", link: "/Settings/Organisation" },
  security: { label: "Decide on two-factor authentication", link: "/Settings/Organisation" },
  joined: { label: "Have a colleague join", link: "/Settings/Users" },
  first_ncr: { label: "Record your first non-conformance", link: "/Non-Conformance/Register/new" },
};

const DAY = 24 * 60 * 60 * 1000;
export const TRIAL_WARNING_DAYS = 3;

/** How many days before an invoice is due the banner starts to say so. */
export const INVOICE_WARNING_DAYS = 7;

/** The warning the subscription deserves right now, or null: { kind: invoice_overdue | invoice_due | past_due | cancelling | trial_ending, dismissible, ... }. */
export const subscriptionWarning = (sub, now = Date.now()) => {
  if (!sub) return null;
  // An invoiced subscription is judged by its oldest open invoice: overdue (with the date access stops: the due date plus the grace days) or due within a week.
  if (sub.paymentRoute === "invoice" && sub.openInvoice?.dueOn) {
    const invoice = sub.openInvoice;
    const due = new Date(`${invoice.dueOn}T23:59:59Z`).getTime();
    if (invoice.overdueDays > 0 || due < now) {
      return { kind: "invoice_overdue", dismissible: false, invoice, accessEnds: new Date(new Date(`${invoice.dueOn}T00:00:00Z`).getTime() + ((sub.gracePeriodDays ?? 0) + 1) * DAY).toISOString() };
    }
    const left = due - now;
    if (left <= INVOICE_WARNING_DAYS * DAY) return { kind: "invoice_due", dismissible: true, invoice, daysLeft: Math.max(1, Math.ceil(left / DAY)) };
  }
  if (sub.status === "past_due") {
    const since = sub.pastDueSince ? new Date(sub.pastDueSince).getTime() : null;
    const accessEnds = since ? new Date(since + (sub.gracePeriodDays ?? 0) * DAY).toISOString() : null;
    return { kind: "past_due", dismissible: false, accessEnds };
  }
  if (sub.cancelAtPeriodEnd && sub.status !== "cancelled") return { kind: "cancelling", dismissible: true, endsOn: sub.currentPeriodEnd };
  if (sub.status === "trialing" && sub.trialEnd) {
    const left = new Date(sub.trialEnd).getTime() - now;
    if (left > 0 && left <= TRIAL_WARNING_DAYS * DAY) return { kind: "trial_ending", dismissible: true, endsOn: sub.trialEnd, daysLeft: Math.max(1, Math.ceil(left / DAY)) };
  }
  return null;
};
