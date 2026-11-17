// Member onboarding and waiting for a seat (docs/seats-and-member-onboarding-plan.md SM4, SM6).

export const WELCOME_STEPS = [
  { key: "about", label: "About you" },
  { key: "notifications", label: "How we reach you" },
  { key: "done", label: "Ready" },
];

/** The first step not done yet for a welcome from /me (about → notifications → done). */
export const firstOpenStep = (welcome) => (!welcome?.aboutDone ? "about" : !welcome?.notificationsDone ? "notifications" : "done");

/** "Olga Owner", "Olga Owner or Sam Admin", "Olga Owner, Sam Admin or Kim Lee"; null when nobody is named. */
export const managersWords = (names = []) => {
  const list = names.filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`;
};

const DAY = 24 * 60 * 60 * 1000;

/** When the waiting person may remind them again (a day after they were last told), or null when they may now. */
export const nextReminderAt = (lastToldAt, now = Date.now()) => {
  if (!lastToldAt) return null;
  const at = new Date(lastToldAt).getTime() + DAY;
  return at > now ? new Date(at) : null;
};

/** The waiting entry for an organisation in /me, if the person is waiting for a seat there. */
export const waitingFor = (me, organisationId) => me?.seats?.waitingIn?.find((w) => w.id === organisationId) ?? null;

/**
 * "Suspended from Acme by Olga Owner on 17 Nov 2026 at 14:05." from an entry of `suspended` in /me. The person and the time are left out
 * when they were not recorded.
 */
export const suspensionWords = (entry) => {
  const at = entry.suspendedAt ? new Date(entry.suspendedAt) : null;
  const date = at && !Number.isNaN(at.getTime())
    ? `${at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} at ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : null;
  return `Suspended from ${entry.name}${entry.suspendedBy ? ` by ${entry.suspendedBy}` : ""}${date ? ` on ${date}` : ""}.`;
};

/** The organisations the person is suspended from in /me, when they have no active one to go to. */
export const suspendedFrom = (me) => me?.suspended ?? [];

export const SEAT_REQUIRED_EVENT = "qms:seat-required";
