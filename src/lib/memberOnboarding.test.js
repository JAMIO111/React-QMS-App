import { describe, expect, it } from "vitest";
import { suspendedFrom, suspensionWords } from "./memberOnboarding";

describe("suspensionWords", () => {
  it("names the organisation, the person and the day", () => {
    const words = suspensionWords({ name: "Acme Ltd", suspendedBy: "Olga Owner", suspendedAt: "2026-11-17T14:05:00.000Z" });
    expect(words).toMatch(/^Suspended from Acme Ltd by Olga Owner on .*2026.* at /);
  });
  it("leaves out what was not recorded", () => {
    expect(suspensionWords({ name: "Acme Ltd", suspendedBy: null, suspendedAt: null })).toBe("Suspended from Acme Ltd.");
    expect(suspensionWords({ name: "Acme Ltd", suspendedBy: "Olga Owner", suspendedAt: null })).toBe("Suspended from Acme Ltd by Olga Owner.");
  });
});

describe("suspendedFrom", () => {
  it("is empty when /me has none", () => {
    expect(suspendedFrom(undefined)).toEqual([]);
    expect(suspendedFrom({})).toEqual([]);
    expect(suspendedFrom({ suspended: [{ id: "a" }] })).toHaveLength(1);
  });
});
