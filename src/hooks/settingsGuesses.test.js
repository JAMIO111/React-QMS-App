import { describe, expect, it } from "vitest";
import { guessMyOrganisationName, guessOrganisation, guessProfile, guessStructure } from "./useQmsApi";
import { guessNotificationsRead } from "./useNotifications";
import { guessSeat } from "./useSubscription";
import { guessStep } from "./useOnboarding";
import { guessCustomField } from "./useCustomFields";

// What the settings screens show before the server answers (the answer or the refetch then replaces it).

describe("guessNotificationsRead", () => {
  const list = { data: [{ id: "n1", read: false }, { id: "n2", read: false }, { id: "n3", read: true }], unread: 2 };
  it("marks the chosen ones read and lowers the count", () => {
    const next = guessNotificationsRead(list, { ids: ["n1"] });
    expect(next.data.map((n) => n.read)).toEqual([true, false, true]);
    expect(next.unread).toBe(1);
    expect(next.data[2]).toBe(list.data[2]);
  });
  it("marks everything read", () => {
    expect(guessNotificationsRead(list, { all: true })).toMatchObject({ unread: 0, data: [{ read: true }, { read: true }, { read: true }] });
  });
  it("leaves the list alone when nothing changes", () => {
    expect(guessNotificationsRead(list, { ids: ["n3"] })).toBe(list);
    expect(guessNotificationsRead(undefined, { all: true })).toBeUndefined();
  });
});

describe("guessOrganisation", () => {
  const org = { id: "o1", name: "Acme", legalName: null, settings: { themeColour: "purple", useLotsAndSerials: true, baseCurrency: "GBP" } };
  it("takes top-level fields and settings as sent, keeping the other settings", () => {
    const next = guessOrganisation(org, { name: "Acme Ltd", settings: { useLotsAndSerials: false, baseCurrency: "eur" } });
    expect(next).toEqual({ id: "o1", name: "Acme Ltd", legalName: null, settings: { themeColour: "purple", useLotsAndSerials: false, baseCurrency: "EUR" } });
  });
  it("returns the same object when nothing changes", () => {
    expect(guessOrganisation(org, { settings: { themeColour: "purple" } })).toBe(org);
  });
  it("renames the organisation in /me", () => {
    const me = { memberships: [{ organisation: { id: "o1", name: "Acme" } }, { organisation: { id: "o2", name: "Other" } }] };
    const next = guessMyOrganisationName(me, "o1", "Acme Ltd");
    expect(next.memberships.map((m) => m.organisation.name)).toEqual(["Acme Ltd", "Other"]);
    expect(next.memberships[1]).toBe(me.memberships[1]);
  });
});

describe("guessStructure", () => {
  const sitesKey = ["api", "org", "o1", "sites", { includeInactive: true }];
  const activeSites = ["api", "org", "o1", "sites", { includeInactive: false }];
  const sites = { data: [{ id: "s1", name: "Main", active: true }, { id: "s2", name: "B", active: true }] };
  it("merges an edit into the row", () => {
    expect(guessStructure(sites, { resource: "sites", id: "s1", body: { name: "Main site", timezone: "Asia/Tokyo" } }, sitesKey).data[0]).toEqual({ id: "s1", name: "Main site", active: true, timezone: "Asia/Tokyo" });
  });
  it("drops a switched-off row only from lists of active ones", () => {
    expect(guessStructure(sites, { resource: "sites", id: "s1", body: { active: false } }, sitesKey).data).toHaveLength(2);
    expect(guessStructure(sites, { resource: "sites", id: "s1", body: { active: false } }, activeSites).data.map((s) => s.id)).toEqual(["s2"]);
  });
  it("adds a new department as a placeholder to its site's lists and the organisation-wide ones only", () => {
    const deps = { data: [{ id: "d1", code: "QA", siteId: "s1" }] };
    const vars = { resource: "departments", body: { code: "MFG", name: "Manufacturing", siteId: "s1" } };
    const added = guessStructure(deps, vars, ["api", "org", "o1", "departments", "s1", { includeInactive: true }]);
    expect(added.data[1]).toEqual({ id: expect.stringMatching(/^pending-/), code: "MFG", name: "Manufacturing", siteId: "s1", active: true });
    expect(guessStructure(deps, vars, ["api", "org", "o1", "departments", "all", { includeInactive: false }]).data).toHaveLength(2);
    expect(guessStructure(deps, vars, ["api", "org", "o1", "departments", "s2", { includeInactive: true }])).toBe(deps);
    expect(guessStructure(sites, vars, sitesKey)).toBe(sites);
  });
});

describe("guessProfile", () => {
  it("shows the new name in /me", () => {
    const me = { profile: { firstName: "Ann", surname: "Lee", jobTitle: null, email: "a@x" } };
    expect(guessProfile(me, { firstName: "Anna", surname: "Lee", jobTitle: "QE" }).profile).toEqual({ firstName: "Anna", surname: "Lee", jobTitle: "QE", email: "a@x" });
    expect(guessProfile(me, { surname: "Lee" })).toBe(me);
  });
});

describe("guessSeat", () => {
  const assignments = { data: [{ membershipId: "m1", plan: { slug: "observer", name: "Observer" } }, { membershipId: "m2", plan: null }] };
  const overview = {
    items: [
      { planSlug: "observer", assigned: 1, available: 1 },
      { planSlug: "controller", assigned: 0, available: 2 },
    ],
    totals: { seatsAssigned: 1, seatsAvailable: 3 },
  };
  it("gives a seat and moves the counts", () => {
    const vars = { action: "assign", membershipId: "m1", planSlug: "controller", planName: "Controller", previous: "observer" };
    expect(guessSeat(assignments, "assignments", vars).data[0].plan).toEqual({ slug: "controller", name: "Controller" });
    const next = guessSeat(overview, "overview", vars);
    expect(next.items).toEqual([
      { planSlug: "observer", assigned: 0, available: 2 },
      { planSlug: "controller", assigned: 1, available: 1 },
    ]);
    expect(next.totals).toEqual({ seatsAssigned: 1, seatsAvailable: 3 });
  });
  it("takes a seat away", () => {
    const vars = { action: "remove", membershipId: "m1", previous: "observer" };
    expect(guessSeat(assignments, "assignments", vars).data[0].plan).toBeNull();
    expect(guessSeat(overview, "overview", vars).items[0]).toEqual({ planSlug: "observer", assigned: 0, available: 2 });
  });
  it("leaves other caches alone", () => {
    expect(guessSeat(overview, "plans", { action: "remove", membershipId: "m1", previous: "observer" })).toBe(overview);
    expect(guessSeat(assignments, "assignments", { action: "remove", membershipId: "m2", previous: null })).toBe(assignments);
  });
});

describe("guessStep", () => {
  const state = {
    currentStep: "details",
    steps: [
      { key: "organisation", status: "done", auto: true },
      { key: "details", status: "pending", auto: false },
      { key: "security", status: "pending", auto: false },
      { key: "review", status: "pending", auto: true },
    ],
  };
  it("marks the step and moves the current step on", () => {
    const next = guessStep(state, { step: "details", status: "skipped" });
    expect(next.steps[1].status).toBe("skipped");
    expect(next.currentStep).toBe("security");
    expect(guessStep(next, { step: "security", status: "done" }).currentStep).toBe("review");
  });
  it("never marks a step the server works out", () => {
    expect(guessStep(state, { step: "review", status: "done" }).steps[3].status).toBe("pending");
  });
});

describe("guessCustomField", () => {
  const list = {
    data: [
      { id: "f1", entityType: "part", label: "Drawing", active: true, options: [] },
      { id: "f2", entityType: "part", label: "Colour", active: false, retireReason: "old", options: [] },
    ],
    entities: [{ entityType: "part", activeCount: 1 }],
  };
  const all = ["api", "org", "o1", "custom-fields", "part", "all"];
  const active = ["api", "org", "o1", "custom-fields", "part", "active"];
  it("merges an edit", () => {
    expect(guessCustomField(list, { action: "update", id: "f1", body: { label: "Drawing no." } }, all).data[0].label).toBe("Drawing no.");
  });
  it("retires a field, dropping it from lists of active fields", () => {
    const next = guessCustomField(list, { action: "retire", id: "f1", reason: "Not used" }, all);
    expect(next.data[0]).toMatchObject({ active: false, retireReason: "Not used" });
    expect(next.entities[0].activeCount).toBe(0);
    expect(guessCustomField(list, { action: "retire", id: "f1", reason: "x" }, active).data.map((f) => f.id)).toEqual(["f2"]);
  });
  it("brings one back", () => {
    const next = guessCustomField(list, { action: "reactivate", id: "f2" }, all);
    expect(next.data[1]).toMatchObject({ active: true, retireReason: null });
    expect(next.entities[0].activeCount).toBe(2);
  });
  it("leaves lists without the field alone", () => {
    expect(guessCustomField(list, { action: "retire", id: "zz" }, all)).toBe(list);
  });
});
