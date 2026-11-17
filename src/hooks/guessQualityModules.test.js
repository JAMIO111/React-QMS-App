import { describe, expect, it } from "vitest";
import { guessDocuments } from "./useDocuments";
import { guessAlerts } from "./useDocumentation";
import { guessCompetence } from "./useCompetence";
import { auditGuessed, guessAudits } from "./useAudits";
import { guessRuleStatus } from "./useWorkflows";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

describe("guessDocuments (what document screens show before the server answers)", () => {
  const doc = { id: "d1", title: "Old", reviewMonths: null, owner: { id: "u1", name: "Ann" }, targets: [], skills: [], links: [], rowVersion: "v1" };
  it("edits plain fields and the owner, never the version", () => {
    const next = guessDocuments(doc, { action: "updateDocument", id: "d1", body: { title: "New", reviewMonths: 6, ownerId: "u2", rowVersion: "v0" }, show: { owner: { id: "u2", name: "Bob" } } });
    expect(next).toMatchObject({ title: "New", reviewMonths: 6, owner: { id: "u2", name: "Bob" }, rowVersion: "v1" });
  });
  it("replaces readers, skills and links with what the screen chose; new links get a placeholder id", () => {
    const targets = [{ kind: "role", refId: "r1", label: "Inspector" }];
    expect(guessDocuments(doc, { action: "setReaders", id: "d1", body: {}, show: { targets } }).targets).toBe(targets);
    expect(guessDocuments(doc, { action: "setSkills", id: "d1", body: {}, show: { skills: [{ id: "k1", name: "CMM" }] } }).skills).toEqual([{ id: "k1", name: "CMM" }]);
    expect(guessDocuments(doc, { action: "setLinks", id: "d1", body: {}, show: { links: [{ kind: "operation", refId: "OP-20", label: "OP-20" }] } }).links[0].id).toMatch(/^pending-/);
  });
  it("acknowledges: my reading, My documents and the badge", () => {
    const rev = { id: "r1", myReading: { acknowledgedAt: null, note: null } };
    expect(guessDocuments(rev, { action: "acknowledge", id: "r1", body: { note: "ok" } }).myReading).toMatchObject({ note: "ok", acknowledgedAt: expect.any(String) });
    const mine = { toRead: [{ revision: { id: "r1" } }, { revision: { id: "r2" } }], acknowledged: [] };
    const after = guessDocuments(mine, { action: "acknowledge", id: "r1", body: {} });
    expect(after.toRead.map((x) => x.revision.id)).toEqual(["r2"]);
    expect(after.acknowledged[0].revision.id).toBe("r1");
    const count = { toRead: 2, overdue: 0, reviews: 1, total: 3 };
    expect(guessDocuments(count, { action: "acknowledge", id: "r1", body: {} }, ["api", "org", "o", "documents", "mine-count"])).toMatchObject({ toRead: 1, total: 2 });
    expect(guessDocuments(count, { action: "acknowledge", id: "r1", body: {} }, ["api", "org", "o", "documentation", "mine-count"])).toBe(count);
  });
  it("adds a reader to that revision's list only, marks requests, removes files, and leaves rule-decided commands alone", () => {
    const list = [{ id: "x1", person: { id: "u1", name: "Ann" } }];
    const added = guessDocuments(list, { action: "addRecipient", id: "r1", body: { userId: "u3" }, show: { name: "Cy" } }, ["api", "org", "o", "documents", "recipients", "r1"]);
    expect(added[1]).toMatchObject({ id: expect.stringMatching(/^pending-/), person: { id: "u3", name: "Cy" } });
    expect(guessDocuments(list, { action: "addRecipient", id: "r9", body: { userId: "u3" } }, ["api", "org", "o", "documents", "recipients", "r1"])).toBe(list);
    expect(guessDocuments({ id: "c1", status: "open" }, { action: "withdrawChangeRequest", id: "c1" }).status).toBe("withdrawn");
    expect(guessDocuments({ id: "c1", status: "open" }, { action: "declineChangeRequest", id: "c1", body: { reason: "No" } })).toMatchObject({ status: "declined", decisionReason: "No" });
    expect(guessDocuments({ files: [{ id: "f1", deletedAt: null }] }, { action: "removeFile", id: "f1", body: { reason: "dup" } }).files[0].deletedAt).toEqual(expect.any(String));
    expect(guessDocuments(doc, { action: "approve", id: "d1", body: {} })).toBe(doc);
  });
});

describe("guessAlerts", () => {
  it("acknowledges on the alert, My alerts and the menu badge", () => {
    const mine = { data: [{ id: "a1", state: "open", me: { acknowledgedAt: null, overdue: true } }], unacknowledged: 1, overdue: 1 };
    const next = guessAlerts(mine, { action: "acknowledge", id: "a1", body: { note: "done" } }, ["api", "org", "o", "documentation", "mine"]);
    expect(next.data[0]).toMatchObject({ state: "acknowledged", me: { note: "done", overdue: false } });
    expect(next.unacknowledged).toBe(0);
    expect(guessAlerts({ unacknowledged: 3 }, { action: "acknowledge", id: "a1" }, ["api", "org", "o", "documentation", "mine-count"]).unacknowledged).toBe(2);
  });
  it("adds a person, withdraws, reopens and discards", () => {
    const recipients = { data: [], totals: { total: 0 } };
    const after = guessAlerts(recipients, { action: "addRecipient", id: "a1", body: { membershipId: "m1" }, show: { name: "Dee" } }, ["api", "org", "o", "documentation", "recipients", "a1"]);
    expect(after.data[0]).toMatchObject({ name: "Dee", id: expect.stringMatching(/^pending-/) });
    expect(after.totals.total).toBe(1);
    expect(guessAlerts({ id: "a1", status: "active" }, { action: "withdraw", id: "a1" }).status).toBe("withdrawn");
    expect(guessAlerts({ id: "a1", status: "expired", expiryDate: "2026-01-01" }, { action: "reopen", id: "a1", body: { expiryDate: "2026-12-31" } })).toMatchObject({ status: "active", expiryDate: "2026-12-31" });
    expect(guessAlerts({ data: [{ id: "a1" }, { id: "a2" }] }, { action: "discard", id: "a1" }, ["api", "org", "o", "documentation", "list"]).data).toEqual([{ id: "a2" }]);
  });
});

describe("guessCompetence", () => {
  const session = { id: "t1", completedCount: 0, attendees: [{ id: "a1", status: "enrolled", employee: { id: "e1", name: "Ada" } }] };
  it("adds an attendee as a placeholder, records results and removes or voids", () => {
    const added = guessCompetence(session, { action: "addAttendee", id: "t1", body: { employeeId: "e2" }, show: { name: "Bo" } });
    expect(added.attendees[1]).toMatchObject({ status: "enrolled", employee: { id: "e2", name: "Bo" }, id: expect.stringMatching(/^pending-/) });
    const recorded = guessCompetence(session, { action: "recordAttendees", id: "t1", body: { attendeeIds: ["a1"], outcome: "completed", completedOn: "2026-11-01", note: null } });
    expect(recorded.attendees[0]).toMatchObject({ status: "completed", completedOn: "2026-11-01" });
    expect(recorded.completedCount).toBe(1);
    expect(guessCompetence(session, { action: "removeAttendee", id: "a1", body: { reason: "x" } }).attendees[0].status).toBe("removed");
    expect(guessCompetence(session, { action: "voidAttendee", id: "a1", body: { reason: "x" } }).attendees[0].status).toBe("voided");
  });
  it("edits, switches, brings back, ends positions and replaces required skills; leaves assessments to the server", () => {
    expect(guessCompetence({ data: [{ id: "c1", active: true }] }, { action: "updateCategory", id: "c1", body: { active: false } }).data[0].active).toBe(false);
    expect(guessCompetence({ id: "s1", active: false, retiredReason: "old" }, { action: "reactivateSkill", id: "s1" })).toMatchObject({ active: true, retiredReason: null });
    expect(guessCompetence({ id: "h1", endedOn: null }, { action: "endPosition", id: "h1", body: { endedOn: "2026-11-01" } }).endedOn).toBe("2026-11-01");
    expect(guessCompetence({ id: "p1", skills: [] }, { action: "setPositionSkills", id: "p1", body: {}, show: { skills: [{ skillId: "s1" }] } }).skills).toEqual([{ skillId: "s1" }]);
    const person = { id: "e1", skills: [] };
    expect(guessCompetence(person, { action: "assess", id: "e1", body: { level: 3 } })).toBe(person);
  });
});

describe("guessAudits", () => {
  it("skips and puts back a slot, retires and reactivates an audit", () => {
    const schedule = { items: [{ id: A, state: "upcoming", daysFromToday: 3, skippedReason: null }] };
    const skipped = guessAudits(schedule, { path: `/audit-occurrences/${A}/skip`, body: { reason: "Shutdown" } });
    expect(skipped.items[0]).toMatchObject({ state: "skipped", skippedReason: "Shutdown" });
    expect(guessAudits(skipped, { path: `/audit-occurrences/${A}/unskip` }).items[0].state).toBe("upcoming");
    expect(guessAudits({ id: A, status: "active", retired: null }, { path: `/audits/${A}/retire`, body: { reason: "Old" } })).toMatchObject({ status: "retired", retired: { reason: "Old" } });
    expect(guessAudits({ id: A, status: "retired", retired: {} }, { path: `/audits/${A}/reactivate` })).toMatchObject({ status: "active", retired: null });
  });
  it("edits a record's plain fields, withdraws a finding, removes a file; never guesses completing or closing", () => {
    expect(guessAudits({ id: A, notes: null, rowVersion: "v1" }, { path: `/audit-records/${A}`, method: "PATCH", body: { notes: "ok", rowVersion: "v1" } }).notes).toBe("ok");
    expect(guessAudits({ id: B, status: "open" }, { path: `/audit-findings/${B}/withdraw`, body: { reason: "x" } }).status).toBe("withdrawn");
    expect(guessAudits([{ id: B, deletedAt: null }], { path: `/audit-attachments/${B}/delete`, body: { reason: "x" } })[0].deletedAt).toEqual(expect.any(String));
    expect(auditGuessed({ path: `/audit-records/${A}/complete` })).toBe(false);
    expect(auditGuessed({ path: `/audit-findings/${B}/close`, body: { note: "x" } })).toBe(false);
    expect(auditGuessed({ path: "/audit-records", body: { auditId: A } })).toBe(false);
    expect(auditGuessed({ path: `/audit-findings/${B}/reopen`, body: { reason: "x" } })).toBe(true);
  });
});

describe("guessRuleStatus", () => {
  it("pauses a rule in the list and the detail; ignores other commands", () => {
    const list = { data: [{ id: "r1", status: "active" }] };
    expect(guessRuleStatus(list, { action: "status", id: "r1", body: { status: "paused" } }).data[0].status).toBe("paused");
    expect(guessRuleStatus(list, { action: "update", id: "r1", body: { name: "x" } })).toBe(list);
  });
});
