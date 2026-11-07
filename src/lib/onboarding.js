/** The set-up wizard (docs/onboarding-plan.md): the steps in order, in plain words. */
export const SETUP_STEPS = [
  { key: "organisation", label: "Organisation", title: "Your organisation", help: "The name people will see, and where it is based." },
  { key: "plan", label: "Plan & seats", title: "Plan and seats", help: "Every organisation needs a subscription with at least one Controller seat, which the owner holds." },
  { key: "details", label: "Details", title: "Organisation details", help: "Your legal name, country, logo and colour. All optional, all changeable later." },
  { key: "sites", label: "Sites & departments", title: "Sites and departments", help: "Where work happens. Add the sites you run and the departments in each." },
  { key: "security", label: "Security", title: "Security", help: "Decide whether everyone must use two-factor authentication, and set up your own." },
  { key: "team", label: "Team & roles", title: "Your team", help: "Invite the people who will work in Fortress QMS and give them their roles." },
  { key: "review", label: "Review", title: "Review and finish", help: "Check what is set up and finish." },
];
export const setupStepIndex = (key) => SETUP_STEPS.findIndex((s) => s.key === key);
export const setupStepOf = (key) => SETUP_STEPS.find((s) => s.key === key) ?? SETUP_STEPS[0];

/** Steps the owner marks themselves; the others (organisation, plan, sites, review) are done by doing them. */
export const MARKABLE_STEPS = ["details", "security", "team"];

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
