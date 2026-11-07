import { describe, expect, it } from "vitest";
import { expiresIn, parseEmails } from "./onboarding";

describe("parseEmails", () => {
  it("finds addresses in any pasted mess, lower-cased, once each, in order", () => {
    expect(parseEmails("Ann <Ann@Example.com>, bob@example.com;\n  ann@example.com  cy@example.com.")).toEqual(["ann@example.com", "bob@example.com", "cy@example.com"]);
  });
  it("ignores what is not an address, and copes with nothing", () => {
    expect(parseEmails("hello world, @nope, a@b")).toEqual([]);
    expect(parseEmails("")).toEqual([]);
    expect(parseEmails(null)).toEqual([]);
  });
  it("handles a spreadsheet column pasted with tabs and quotes", () => {
    expect(parseEmails('"a@x.org"\t"b@x.org"')).toEqual(["a@x.org", "b@x.org"]);
  });
});

describe("expiresIn", () => {
  const now = new Date("2026-11-07T12:00:00Z").getTime();
  it("counts whole days, rounding up", () => {
    expect(expiresIn("2026-11-21T12:00:00Z", now)).toBe("14 days");
    expect(expiresIn("2026-11-08T13:00:00Z", now)).toBe("2 days");
    expect(expiresIn("2026-11-08T11:00:00Z", now)).toBe("1 day");
  });
  it("says today when it is nearly over, and nothing without an expiry", () => {
    expect(expiresIn("2026-11-07T18:00:00Z", now)).toBe("1 day");
    expect(expiresIn("2026-11-07T11:00:00Z", now)).toBe("today");
    expect(expiresIn(null, now)).toBeNull();
  });
});
