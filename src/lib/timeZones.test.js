import { describe, expect, it } from "vitest";
import { TIME_ZONES, timeZoneOptions } from "./timeZones";

describe("time zones", () => {
  it("lists many IANA zones, UTC first, with no duplicates", () => {
    expect(TIME_ZONES.length).toBeGreaterThan(20);
    expect(TIME_ZONES[0]).toBe("UTC");
    expect(TIME_ZONES).toContain("Europe/London");
    expect(new Set(TIME_ZONES).size).toBe(TIME_ZONES.length);
  });
  it("keeps a zone the browser does not list, so an older site can still be shown", () => {
    expect(timeZoneOptions("Mars/Olympus")[0]).toMatchObject({ id: "Mars/Olympus", name: "Mars/Olympus" });
    expect(timeZoneOptions("Europe/London").filter((o) => o.id === "Europe/London")).toHaveLength(1);
  });
});
