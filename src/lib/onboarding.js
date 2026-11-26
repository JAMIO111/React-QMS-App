/**
 * The set-up wizard (docs/onboarding-plan.md): the steps in the order the owner sees them. Everything that costs nothing comes first; the plan and seats
 * come last, once the owner knows how many people they will need, and the invitations are sent after it. `server` names the steps the database tracks
 * for a page (the "Organisation" page covers the database's organisation and details steps).
 */
export const SETUP_STEPS = [
  { key: "organisation", label: "Organisation", title: "Your organisation", help: "Your name, legal details, logo and colour. Only the name is needed; the rest can wait.", server: ["organisation", "details"] },
  { key: "sites", label: "Sites & departments", title: "Sites and departments", help: "Where work happens. Add the sites you run and the departments in each.", server: ["sites"] },
  { key: "security", label: "Security", title: "Security", help: "Decide whether everyone must use two-factor authentication, and set up your own.", server: ["security"] },
  { key: "team", label: "Your team", title: "Your team", help: "Plan who will work in Fortress QMS and what each person will do. Invitations go out once your plan is active.", server: ["team"] },
  { key: "plan", label: "Plan & seats", title: "Plan and seats", help: "Choose the seats your team needs. Every organisation needs a Controller seat, which the owner holds.", server: ["plan"] },
  { key: "review", label: "Review", title: "Review and finish", help: "Everything you have set up, in one place.", server: ["review"] },
];
export const setupStepIndex = (key) => SETUP_STEPS.findIndex((s) => s.key === key);
export const setupStepOf = (key) => SETUP_STEPS.find((s) => s.key === key) ?? SETUP_STEPS[0];

/** Steps the owner marks themselves; the others (organisation, sites, plan, review) are done by doing them. The Organisation page marks its optional details when it is left. */
export const MARKABLE_STEPS = ["security", "team"];

/** Where a page stands, from the database's own steps: done when its required ones are done, skipped when they were skipped, else pending. */
export const pageStatus = (state, key) => {
  const def = setupStepOf(key);
  const found = def.server.map((k) => state.steps.find((x) => x.key === k)).filter(Boolean);
  const main = found[0];
  if (!main) return { status: "pending", required: false };
  return { status: main.status, required: found.some((x) => x.required) };
};

/**
 * The page the wizard opens on: the first one not done or skipped (the review last). The Organisation page counts as open until its optional
 * details have been looked at too, so a new organisation starts there rather than on the first thing that happens to be missing.
 */
export const currentSetupStep = (state) => {
  const detailsLooked = state.steps.find((x) => x.key === "details")?.status !== "pending";
  return SETUP_STEPS.find((s) => s.key !== "review" && (pageStatus(state, s.key).status === "pending" || (s.key === "organisation" && !detailsLooked)))?.key ?? "review";
};

/** The invitations the owner has planned but cannot send until the plan is active, kept in this browser. */
const DRAFT_KEY = (organisationId) => `qms.teamDraft.${organisationId}`;
export const loadTeamDraft = (organisationId) => {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY(organisationId)) ?? "null");
    if (saved && Array.isArray(saved.rows)) {
      return { message: String(saved.message ?? ""), rows: saved.rows.filter((r) => r && typeof r.email === "string").map((r) => ({ email: r.email, roleId: r.roleId ?? "", departmentIds: Array.isArray(r.departmentIds) ? r.departmentIds : [], packageSlug: r.packageSlug ?? "" })) };
    }
  } catch {
    // No saved draft.
  }
  return { rows: [], message: "" };
};
export const saveTeamDraft = (organisationId, draft) => {
  try {
    if (draft.rows.length === 0 && !draft.message) localStorage.removeItem(DRAFT_KEY(organisationId));
    else localStorage.setItem(DRAFT_KEY(organisationId), JSON.stringify(draft));
  } catch {
    // The draft is just not remembered.
  }
};
export const clearTeamDraft = (organisationId) => saveTeamDraft(organisationId, { rows: [], message: "" });

/** Seats the planned team would take, by package, with the owner's Controller seat added: what the plan step starts from. */
export const seatsForDraft = (rows) => {
  const seats = { controller: 1, contributor: 0, observer: 0 };
  for (const r of rows) if (r.packageSlug && r.packageSlug in seats) seats[r.packageSlug] += 1;
  return seats;
};

/** Remembers, for this browser session, that the owner chose "finish later", so the app stops sending them back to /setup. */
const DEFERRED_KEY = "qms.setupDeferred";
export const setupDeferred = () => {
  try {
    return sessionStorage.getItem(DEFERRED_KEY) === "1";
  } catch {
    return false;
  }
};
export const deferSetup = () => {
  try {
    sessionStorage.setItem(DEFERRED_KEY, "1");
  } catch {
    // The choice just is not remembered.
  }
};
export const resumeSetup = () => {
  try {
    sessionStorage.removeItem(DEFERRED_KEY);
  } catch {
    // Nothing to forget.
  }
};

/** Countries offered for the organisation's country (ISO 3166-1 alpha-2); names come from the browser. */
export const COUNTRY_CODES = [
  "GB", "IE", "US", "CA", "AU", "NZ", "DE", "FR", "ES", "IT", "PT", "NL", "BE", "LU", "CH", "AT", "SE", "NO", "DK", "FI", "IS", "PL", "CZ", "SK", "HU", "RO", "BG", "GR", "HR", "SI",
  "EE", "LV", "LT", "TR", "IL", "AE", "SA", "QA", "IN", "PK", "BD", "LK", "CN", "JP", "KR", "TW", "HK", "SG", "MY", "TH", "VN", "ID", "PH", "ZA", "EG", "MA", "NG", "KE", "MX", "BR", "AR", "CL", "CO", "PE",
];
export const countryName = (code) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
};
export const countryOptions = () => COUNTRY_CODES.map((code) => ({ id: code, name: countryName(code), hint: code })).sort((a, b) => a.name.localeCompare(b.name));

/** Pulls email addresses out of pasted text (separated by commas, semicolons, spaces or new lines; "Name <a@b.com>" works). Lower-cased, de-duplicated, in order. */
export const parseEmails = (text) => {
  const found = String(text ?? "").match(/[^\s,;<>"']+@[^\s,;<>"']+\.[^\s,;<>"']+/g) ?? [];
  const seen = new Set();
  const emails = [];
  for (const raw of found) {
    const email = raw.toLowerCase().replace(/[.)]+$/, "");
    if (!seen.has(email)) {
      seen.add(email);
      emails.push(email);
    }
  }
  return emails;
};

/** How long until an invitation expires, in words ("12 days", "today") or null when it has no expiry. */
export const expiresIn = (iso, now = Date.now()) => {
  if (!iso) return null;
  const days = Math.ceil((new Date(iso).getTime() - now) / 864e5);
  if (days <= 0) return "today";
  return days === 1 ? "1 day" : `${days} days`;
};
