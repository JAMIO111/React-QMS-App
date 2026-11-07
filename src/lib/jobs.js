/** The machine an operator used last on this device, so the start pop-up opens on it. Never required: storage can be blocked. */
const KEY = "fortress.lastMachine";

export const lastMachine = (organisationId) => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}")[organisationId] ?? null;
  } catch {
    return null;
  }
};

export const rememberMachine = (organisationId, machine) => {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    localStorage.setItem(KEY, JSON.stringify({ ...all, [organisationId]: { id: machine.id, name: machine.name } }));
  } catch {
    /* remembering is a convenience only */
  }
};

/** "2h 05m" / "12m" since the job started. */
export const elapsed = (iso, now = Date.now()) => {
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
