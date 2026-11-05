import { describe, expect, it } from "vitest";
import { notificationLink, timeAgo } from "./notifications";
import { groupPreferences } from "../components/Settings/SettingsNotifications";

describe("notificationLink", () => {
  it("routes records and settings", () => {
    expect(notificationLink({ entityType: "nonconformances", entityId: "1", details: { source: "supplier" } })).toBe("/Non-Conformance/Supplier/1");
    expect(notificationLink({ entityType: "calibrations", entityId: "c", details: { gauge_id: "g" } })).toBe("/Calibration/Gauges/g/calibrations/c");
    expect(notificationLink({ entityType: "billing_invoices", entityId: "i" })).toBe("/Settings/Subscription");
    expect(notificationLink({ entityType: "unknown", entityId: "x" })).toBeNull();
  });
});

describe("timeAgo", () => {
  it("is relative for recent times", () => {
    const now = Date.parse("2025-01-01T12:00:00Z");
    expect(timeAgo("2025-01-01T11:59:50Z", now)).toBe("just now");
    expect(timeAgo("2025-01-01T11:30:00Z", now)).toBe("30m ago");
    expect(timeAgo("2025-01-01T09:00:00Z", now)).toBe("3h ago");
  });
});

describe("groupPreferences", () => {
  it("groups by module and entity", () => {
    const g = groupPreferences([
      { group: "Parts", entity: "Part", action: "created", eventKey: "parts.created" },
      { group: "Parts", entity: "Part", action: "updated", eventKey: "parts.updated" },
    ]);
    expect(g).toHaveLength(1);
    expect(Object.keys(g[0].rows[0].actions)).toEqual(["created", "updated"]);
  });
});
