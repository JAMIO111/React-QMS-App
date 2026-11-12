import { describe, expect, it } from "vitest";
import { notificationLink, timeAgo } from "./notifications";
import { groupPreferences } from "../components/Settings/SettingsNotifications";
import { applyPreference } from "../hooks/useNotifications";

describe("notificationLink", () => {
  it("routes records and settings", () => {
    expect(notificationLink({ entityType: "nonconformances", entityId: "1", details: { source: "supplier" } })).toBe("/Non-Conformance/Register/1");
    expect(notificationLink({ entityType: "competence_assessments", entityId: "a", details: {} })).toBe("/Competence/Mine");
    expect(notificationLink({ entityType: "risks", entityId: "r", details: { risk_id: "r" } })).toBe("/Risk/Register/r");
    expect(notificationLink({ entityType: "management_review_actions", entityId: "a", details: { review_id: "m" } })).toBe("/Management-Review/My-Actions");
    expect(notificationLink({ entityType: "risk_actions", entityId: "x", details: { risk_id: "r" } })).toBe("/Risk/Register/r");
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

describe("notificationLink", () => {
  it("leads a quality alert notice to the alert, or to My alerts when the alert is not named", () => {
    expect(notificationLink({ entityType: "quality_alert_recipients", entityId: "r1", details: { alert_id: "a1" } })).toBe("/Documentation/Quality-Alerts/a1");
    expect(notificationLink({ entityType: "quality_alert_recipients", entityId: "r1", details: {} })).toBe("/Documentation/My-Alerts");
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

describe("import alerts and email choices", () => {
  it("leads an import alert to its run", () => {
    expect(notificationLink({ entityType: "integration_alerts", entityId: "a", details: { connection_id: "c", run_id: "r" } })).toBe("/Settings/Integrations/c/runs/r");
    expect(notificationLink({ entityType: "integration_alerts", entityId: "a", details: {} })).toBe("/Settings/Integrations");
  });

  it("shows email on only while the event is shown in the app", () => {
    const p = { eventKey: "parts.created", enabled: true, defaultEnabled: true, overridden: false, email: false, emailDefault: false, emailOverridden: false };
    expect(applyPreference(p, { email: true })).toMatchObject({ enabled: true, email: true, emailOverridden: true, overridden: false });
    expect(applyPreference({ ...p, email: true, emailOverridden: true }, { enabled: false })).toMatchObject({ enabled: false, overridden: true, email: false });
    expect(applyPreference({ ...p, emailDefault: true }, { email: null })).toMatchObject({ email: true, emailOverridden: false });
    expect(applyPreference({ ...p, enabled: false, overridden: true }, { email: true })).toMatchObject({ email: false });
  });
});
