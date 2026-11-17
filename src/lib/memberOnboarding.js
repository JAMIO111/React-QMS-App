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

export const SEAT_REQUIRED_EVENT = "qms:seat-required";
