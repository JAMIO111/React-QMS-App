import { describe, expect, it } from "vitest";
import { accessFor, accessStatus, lastSeenWords, partyKindLabel, personLine } from "./portal";

describe("portal words", () => {
  it("names the kind of party and the status of an access", () => {
    expect(partyKindLabel("supplier")).toBe("Supplier");
    expect(partyKindLabel("customer")).toBe("Customer");
    expect(accessStatus("invited")).toEqual({ label: "Invited", tone: "warning" });
    expect(accessStatus("suspended").tone).toBe("error");
    expect(accessStatus("odd")).toEqual({ label: "odd", tone: "neutral" });
  });

  it("describes a person with or without a name", () => {
    expect(personLine({ name: "Sam Smith", email: "sam@x.test" })).toBe("Sam Smith (sam@x.test)");
    expect(personLine({ name: null, email: "sam@x.test" })).toBe("sam@x.test");
  });

  it("says when someone last signed in", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    expect(lastSeenWords(null, now)).toBe("Never");
    expect(lastSeenWords("2026-11-18T11:59:30Z", now)).toBe("Just now");
    expect(lastSeenWords("2026-11-18T11:30:00Z", now)).toBe("30 minutes ago");
    expect(lastSeenWords("2026-11-18T11:00:00Z", now)).toBe("1 hour ago");
    expect(lastSeenWords("2026-11-15T12:00:00Z", now)).toBe("3 days ago");
    expect(lastSeenWords("2026-09-01T12:00:00Z", now)).toMatch(/Sept?\.? 2026|1 Sep/);
  });

  it("picks the access for an organisation, else the first", () => {
    const portal = [{ organisationId: "o1" }, { organisationId: "o2" }];
    expect(accessFor(portal, "o2")).toBe(portal[1]);
    expect(accessFor(portal, "nope")).toBe(portal[0]);
    expect(accessFor([], "o1")).toBeNull();
  });
});
