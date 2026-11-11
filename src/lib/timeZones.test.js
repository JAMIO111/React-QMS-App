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

import { utcOffsetLabel } from "./timeZones";

describe("time zone options show offsets and every current zone", () => {
  const at = new Date("2026-01-15T12:00:00Z");
  it("has the current IANA names the browser leaves out", () => {
    for (const z of ["Asia/Kolkata", "Europe/Kyiv", "Asia/Ho_Chi_Minh", "Asia/Yangon", "Asia/Kathmandu", "America/Argentina/Buenos_Aires", "Pacific/Kanton"]) {
      expect(TIME_ZONES, z).toContain(z);
    }
  });
  it("shows the offset from UTC under each option", () => {
    expect(utcOffsetLabel("Asia/Kolkata", at)).toBe("UTC+05:30");
    expect(utcOffsetLabel("Asia/Kathmandu", at)).toBe("UTC+05:45");
    expect(utcOffsetLabel("America/St_Johns", at)).toBe("UTC-03:30");
    expect(utcOffsetLabel("UTC", at)).toBe("UTC+00:00");
    const kolkata = timeZoneOptions("", at).find((o) => o.id === "Asia/Kolkata");
    expect(kolkata.hint).toBe("UTC+05:30");
    expect(kolkata.keywords).toContain("+5:30");
  });
  it("follows daylight saving", () => {
    expect(utcOffsetLabel("Europe/London", new Date("2026-01-15T12:00:00Z"))).toBe("UTC+00:00");
    expect(utcOffsetLabel("Europe/London", new Date("2026-07-15T12:00:00Z"))).toBe("UTC+01:00");
  });
});
