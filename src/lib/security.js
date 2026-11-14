// Words for Settings → Security and the blocked screen (docs/security-plan.md SE4).

export const MODES = [
  { value: "off", label: "Off", description: "Anyone in the organisation can use Fortress from any network." },
  {
    value: "monitor",
    label: "Monitor",
    description: "Nobody is blocked, but requests from outside the approved networks are recorded below, so you can find the networks you missed before enforcing.",
  },
  {
    value: "enforce",
    label: "Enforce",
    description: "Only the approved networks can use this organisation. Everyone else sees a message saying their network is not allowed. Emails only say that there is something new.",
  },
];

export const ENFORCE_WORD = "enforce";

export const modeLabel = (mode) => MODES.find((m) => m.value === mode)?.label ?? mode;

/** What stops enforcing now (the server checks the same). */
export const enforceProblems = (policy) => {
  const problems = [];
  if (!policy) return ["The policy has not loaded."];
  if (policy.activeCount === 0) problems.push("Add and switch on at least one approved network.");
  if (!policy.address) problems.push("Fortress cannot see your address, so it cannot check you will still get in.");
  else if (!policy.covered) problems.push(`Your own address (${policy.address}) is not in an approved network. Add it first, or you would be blocked.`);
  return problems;
};

export const whenWords = (iso) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

/** "Ada Owner from 198.51.100.200, 3 times, last 14 Nov 2026, 09:30" */
export const denialWords = (d) => {
  const who = d.person?.name ?? (d.person ? "Someone" : "Someone not signed in");
  const times = d.attempts === 1 ? "once" : `${d.attempts} times`;
  return `${who} from ${d.address}, ${times}, last ${whenWords(d.lastAt)}`;
};

/** Event the API client raises when a request answers 403 network_not_allowed. */
export const NETWORK_BLOCKED_EVENT = "qms:network-blocked";
