import { describe, expect, it, vi } from "vitest";
import { guessCapa, CAPA_GUESSED } from "./useCapa";
import { guessRisk, RISK_GUESSED } from "./useRisk";
import { guessObjective, guessReview, REVIEW_GUESSED } from "./useManagementReview";
import { isPending } from "../lib/optimistic";
import { sendCommand, setFields } from "../lib/guessCommands";

const capa = () => ({
  id: "c1",
  title: "Cracks",
  problemStatement: null,
  d3NoContainmentReason: null,
  owner: { membershipId: "m1", name: "Ada" },
  problem: { what: "Cracks", who: null },
  team: [{ id: "t1", membershipId: "m1", name: "Ada", role: "leader", endedAt: null }],
  ncrs: [{ id: "l1", nonconformanceId: "n1", endedAt: null, endReason: null }],
  analyses: [{ id: "an1", title: "Is / Is-Not", data: { rows: [] } }],
  rootCauses: [{ id: "r1", kind: "occurrence", description: "Worn tool", verified: false, verificationMethod: null }],
  actions: [{ id: "a1", phase: "interim", description: "Sort stock", status: "open", owner: null, dueDate: null, evidenceNote: null, cancelReason: null, doneAt: null }],
});

describe("guessCapa", () => {
  it("changes the header and the 5W2H, leaving the version out", () => {
    const next = guessCapa({ data: [capa()] }, { action: "update", id: "c1", body: { title: "Cracked bar", d2Who: "Line 2", rowVersion: "v1" } });
    expect(next.data[0].title).toBe("Cracked bar");
    expect(next.data[0].problem.who).toBe("Line 2");
    expect(next.data[0].rowVersion).toBeUndefined();
  });

  it("names a new owner from what the screen knows", () => {
    const next = guessCapa(capa(), { action: "update", id: "c1", body: { ownerMembershipId: "m2" }, show: { ownerName: "Bob" } });
    expect(next.owner).toEqual({ membershipId: "m2", name: "Bob" });
  });

  it("adds a team member as a placeholder and ends one who leaves", () => {
    const added = guessCapa(capa(), { action: "addTeam", id: "c1", body: { membershipId: "m2", role: "member" }, show: { name: "Bob" } });
    expect(added.team).toHaveLength(2);
    expect(added.team[1]).toMatchObject({ name: "Bob", role: "member", external: false });
    expect(isPending(added.team[1].id)).toBe(true);
    const left = guessCapa(capa(), { action: "updateTeam", id: "t1", body: { ended: true } });
    expect(left.team[0].endedAt).toEqual(expect.any(String));
    expect(guessCapa(capa(), { action: "updateTeam", id: "t1", body: { role: "champion" } }).team[0].role).toBe("champion");
  });

  it("ends an NC link on the 8D and drops the 8D from the NC's own list", () => {
    expect(guessCapa(capa(), { action: "unlinkNcr", id: "l1", body: { reason: "Wrong NC" } }).ncrs[0]).toMatchObject({ endReason: "Wrong NC", endedAt: expect.any(String) });
    expect(guessCapa({ data: [{ id: "c1", linkId: "l1" }, { id: "c2", linkId: "l2" }] }, { action: "unlinkNcr", id: "l1", body: {} }).data).toEqual([{ id: "c2", linkId: "l2" }]);
  });

  it("removes analyses and causes, verifies and withdraws a verification", () => {
    expect(guessCapa(capa(), { action: "removeAnalysis", id: "an1" }).analyses).toEqual([]);
    expect(guessCapa(capa(), { action: "removeRootCause", id: "r1" }).rootCauses).toEqual([]);
    const verified = guessCapa(capa(), { action: "updateRootCause", id: "r1", body: { verified: true, verificationMethod: "Trial" } });
    expect(verified.rootCauses[0]).toMatchObject({ verified: true, verificationMethod: "Trial" });
    expect(guessCapa(verified, { action: "updateRootCause", id: "r1", body: { verified: false } }).rootCauses[0].verified).toBe(false);
  });

  it("adds an action as a placeholder and moves one through done, reopened and cancelled", () => {
    const added = guessCapa(capa(), { action: "addAction", id: "c1", body: { phase: "corrective", description: "New tool", ownerTeamMemberId: "t1" }, show: { ownerName: "Ada" } });
    expect(added.actions[1]).toMatchObject({ phase: "corrective", description: "New tool", status: "open", owner: { teamMemberId: "t1", name: "Ada" } });
    expect(isPending(added.actions[1].id)).toBe(true);
    const done = guessCapa(capa(), { action: "completeAction", id: "a1", body: { evidenceNote: "Sorted 200" } });
    expect(done.actions[0]).toMatchObject({ status: "done", evidenceNote: "Sorted 200" });
    expect(guessCapa(done, { action: "reopenAction", id: "a1" }).actions[0]).toMatchObject({ status: "open", doneAt: null });
    expect(guessCapa(capa(), { action: "cancelAction", id: "a1", body: { reason: "Not needed" } }).actions[0]).toMatchObject({ status: "cancelled", cancelReason: "Not needed" });
  });

  it("guesses nothing for steps, closing or verification: the database works those out", () => {
    for (const action of ["create", "completeStep", "reopenStep", "cancel", "reopen", "close", "addVerification", "linkNcr", "addAnalysis", "addRootCause"]) {
      expect(CAPA_GUESSED.has(action)).toBe(false);
      const data = capa();
      expect(guessCapa(data, { action, id: "c1", body: {} })).toBe(data);
    }
  });
});

const risk = () => ({
  id: "r1",
  status: "open",
  title: "Foundry",
  strategy: null,
  treatmentPlan: null,
  inherent: { band: "high" },
  owner: { id: "u1", name: "Ada" },
  openActions: 0,
  links: [],
  actions: [{ id: "x1", description: "Audit", status: "open", owner: { id: "u1", name: "Ada" }, dueDate: null, doneNote: null, cancelReason: null }],
  acceptances: [{ id: "p1", status: "proposed", canDecide: true, canWithdraw: true }],
});

describe("guessRisk", () => {
  it("changes details, the approach and the links", () => {
    expect(guessRisk(risk(), { action: "update", id: "r1", body: { title: "Single foundry", ownerId: "u2" }, show: { ownerName: "Bob" } })).toMatchObject({ title: "Single foundry", owner: { id: "u2", name: "Bob" } });
    expect(guessRisk(risk(), { action: "setTreatment", id: "r1", body: { strategy: "mitigate", plan: "Second source" } })).toMatchObject({ strategy: "mitigate", treatmentPlan: "Second source" });
    const links = [{ kind: "part", id: "p1", reference: "P-1" }];
    expect(guessRisk(risk(), { action: "setLinks", id: "r1", body: { links: [{ kind: "part", id: "p1" }] }, show: { links } }).links).toBe(links);
  });

  it("retires and brings back", () => {
    const retired = guessRisk(risk(), { action: "retire", id: "r1", body: { reason: "Raised twice" } });
    expect(retired).toMatchObject({ status: "retired", retiredReason: "Raised twice" });
    expect(guessRisk(retired, { action: "reactivate", id: "r1" }).status).toBe("open");
  });

  it("adds, completes, cancels and reopens actions, and withdraws a proposal", () => {
    const added = guessRisk(risk(), { action: "addAction", id: "r1", body: { description: "Qualify", ownerId: "u2" }, show: { ownerName: "Bob" } });
    expect(added.actions[1]).toMatchObject({ description: "Qualify", status: "open", owner: { id: "u2", name: "Bob" } });
    expect(isPending(added.actions[1].id)).toBe(true);
    expect(added.openActions).toBe(1);
    const done = guessRisk(risk(), { action: "completeAction", id: "x1", body: { note: "Passed" } });
    expect(done.actions[0]).toMatchObject({ status: "done", doneNote: "Passed" });
    expect(guessRisk(done, { action: "reopenAction", id: "x1" }).actions[0]).toMatchObject({ status: "open", doneNote: null });
    expect(guessRisk(risk(), { action: "cancelAction", id: "x1", body: { reason: "Moot" } }).actions[0]).toMatchObject({ status: "cancelled", cancelReason: "Moot" });
    expect(guessRisk(risk(), { action: "withdrawAcceptance", id: "p1", body: { reason: "Later" } }).acceptances[0]).toMatchObject({ status: "withdrawn", canDecide: false });
  });

  it("waits for the server on assessments, acceptance decisions, reviews and closing", () => {
    for (const action of ["create", "assess", "proposeAcceptance", "decideAcceptance", "review", "close", "reopen", "saveModel", "createCategory"]) expect(RISK_GUESSED.has(action)).toBe(false);
  });
});

const review = () => ({
  id: "m1",
  title: "H1 review",
  chair: { id: "u1", name: "Ada" },
  attendees: [],
  decisions: [{ id: "d1", description: "Buy a CMM", category: "resources" }],
  actions: [{ id: "x1", description: "Quotes", status: "open", owner: { id: "u1", name: "Ada" }, dueDate: null, doneNote: null, cancelReason: null }],
});

describe("guessReview and guessObjective", () => {
  it("changes details and the chair, and replaces the attendees with the named list", () => {
    expect(guessReview(review(), { action: "update", id: "m1", body: { title: "H2 review", chairId: "u2" }, show: { chairName: "Bob" } })).toMatchObject({ title: "H2 review", chair: { id: "u2", name: "Bob" } });
    const attendees = [{ id: "pending-1", userId: "u2", name: "Bob", attendance: "invited" }];
    expect(guessReview(review(), { action: "setAttendees", id: "m1", body: {}, show: { attendees } }).attendees).toBe(attendees);
  });

  it("adds, edits and removes decisions", () => {
    const added = guessReview(review(), { action: "addDecision", id: "m1", body: { description: "Train", category: "improvement" } });
    expect(added.decisions[1]).toMatchObject({ description: "Train", category: "improvement" });
    expect(isPending(added.decisions[1].id)).toBe(true);
    expect(guessReview(review(), { action: "updateDecision", id: "d1", body: { description: "Buy two" } }).decisions[0].description).toBe("Buy two");
    expect(guessReview(review(), { action: "removeDecision", id: "d1" }).decisions).toEqual([]);
  });

  it("gives, changes, closes, cancels and reopens actions", () => {
    const added = guessReview(review(), { action: "addAction", id: "m1", body: { description: "Train", ownerId: "u2" }, show: { ownerName: "Bob" } });
    expect(added.actions[1]).toMatchObject({ description: "Train", status: "open", owner: { id: "u2", name: "Bob" } });
    expect(guessReview(review(), { action: "updateAction", id: "x1", body: { dueDate: "2026-12-01" } }).actions[0].dueDate).toBe("2026-12-01");
    const done = guessReview(review(), { action: "completeAction", id: "x1", body: { note: "In" } });
    expect(done.actions[0]).toMatchObject({ status: "done", doneNote: "In" });
    expect(guessReview(done, { action: "reopenAction", id: "x1" }).actions[0]).toMatchObject({ status: "open", doneNote: null });
    expect(guessReview(review(), { action: "cancelAction", id: "x1", body: { reason: "Moot" } }).actions[0]).toMatchObject({ status: "cancelled", cancelReason: "Moot" });
  });

  it("waits for the server to plan, start, gather, complete and cancel a review", () => {
    for (const action of ["plan", "start", "gather", "setMinutes", "complete", "cancel"]) expect(REVIEW_GUESSED.has(action)).toBe(false);
  });

  it("changes, retires and brings back an objective", () => {
    const objective = { id: "o1", title: "PPM", target: 100, active: true, owner: { id: "u1", name: "Ada" }, retiredReason: null };
    expect(guessObjective({ data: [objective] }, { action: "update", id: "o1", body: { target: 50, ownerId: "u2" }, show: { ownerName: "Bob" } }).data[0]).toMatchObject({ target: 50, owner: { id: "u2", name: "Bob" } });
    const retired = guessObjective(objective, { action: "retire", id: "o1", body: { reason: "Met" } });
    expect(retired).toMatchObject({ active: false, retiredReason: "Met" });
    expect(guessObjective(retired, { action: "reactivate", id: "o1" })).toMatchObject({ active: true, retiredReason: null });
  });
});

describe("guessCommands helpers", () => {
  it("setFields copies only keys the object has, never the version, and keeps the object when nothing changes", () => {
    const obj = { a: 1, b: "x" };
    expect(setFields(obj, { a: 2, c: 3, rowVersion: "v" })).toEqual({ a: 2, b: "x" });
    expect(setFields(obj, { a: 1 })).toBe(obj);
    expect(setFields({ name: "a" }, { label: "b" }, { label: "name" })).toEqual({ name: "b" });
  });

  it("sendCommand closes at once for a guessed command, and only on success for the others", () => {
    const guessed = new Set(["edit"]);
    const mutation = { mutate: vi.fn() };
    const done = vi.fn();
    sendCommand(mutation, guessed, { action: "edit" }, done);
    expect(done).toHaveBeenCalledTimes(1);
    sendCommand(mutation, guessed, { action: "create" }, done);
    expect(done).toHaveBeenCalledTimes(1);
    mutation.mutate.mock.calls[1][1].onSuccess({ id: "n" });
    expect(done).toHaveBeenCalledTimes(2);
  });
});
