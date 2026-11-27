// Custom roles on screen (docs/custom-roles-plan.md RL3). The database decides what a role may carry; this only groups, words and checks what is typed.

/** What the server never lets into a custom role (role administration stays with the Owner role). */
export const NOT_IN_CUSTOM_ROLES = ["roles.manage"];

export const SEAT_WORDS = { observer: "Observer", contributor: "Contributor", controller: "Controller" };

/** The permissions a person may choose, grouped by module in the order the API gave them: [{ module, items: [permission] }]. */
export const groupPermissions = (permissions = []) => {
  const groups = [];
  for (const p of permissions) {
    if (NOT_IN_CUSTOM_ROLES.includes(p.code)) continue;
    let g = groups.find((x) => x.module === p.module);
    if (!g) groups.push((g = { module: p.module, items: [] }));
    g.items.push(p);
  }
  // Administration last: it is the part that needs care.
  return groups.sort((a, b) => (a.module === "Administration") - (b.module === "Administration"));
};

/** How many of a group's permissions are chosen: "none" | "some" | "all". */
export const groupState = (group, selected) => {
  const n = group.items.filter((p) => selected.has(p.code)).length;
  return n === 0 ? "none" : n === group.items.length ? "all" : "some";
};

/** The read-only part of a group: view permissions (what an Observer seat gives), else anything ending in ".read". */
export const viewOnly = (group) => group.items.filter((p) => p.needs === "observer" || p.code.endsWith(".read") || p.code === "audit.read");

/** What stops a save: [] when it can go. */
export const roleProblems = ({ name, selected }) => {
  const problems = [];
  if (!name.trim()) problems.push("Give the role a name.");
  if (name.trim().length > 60) problems.push("The role name is up to 60 characters.");
  if (selected.size === 0) problems.push("Choose at least one permission.");
  return problems;
};

/** "3 people hold this role." */
export const holdersWords = (n) => (n === 0 ? "Nobody holds it yet" : n === 1 ? "1 person holds it" : `${n} people hold it`);

/** The seat level the highest of the chosen permissions asks for (null when none asks): informs the owner, the server does not use it. */
export const highestSeat = (permissions, selected) => {
  const order = ["observer", "contributor", "controller"];
  let top = -1;
  for (const p of permissions) if (selected.has(p.code) && p.needs) top = Math.max(top, order.indexOf(p.needs));
  return top < 0 ? null : order[top];
};
