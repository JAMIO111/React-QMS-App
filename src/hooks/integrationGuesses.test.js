import { describe, expect, it } from "vitest";
import { guessConnectionChange, guessTemplateChange } from "./useIntegrations";
import { guessAgentChange } from "./useAgents";

const connection = { id: "c1", name: "Sage", status: "active", recordSources: [{ entityType: "machine", source: { schema: "dbo", object: "m" } }, { entityType: "part", source: { file: "p.csv" } }] };

describe("guessConnectionChange", () => {
  it("moves a connection's status at once for pause, resume and retire, wherever it is cached", () => {
    const list = { data: [connection, { id: "c2", status: "active" }] };
    expect(guessConnectionChange({ action: "pause", id: "c1" })(list).data.map((c) => c.status)).toEqual(["paused", "active"]);
    expect(guessConnectionChange({ action: "resume", id: "c1" })({ ...connection, status: "paused" }).status).toBe("active");
    expect(guessConnectionChange({ action: "retire", id: "c1" })(connection).status).toBe("retired");
  });

  it("shows a run cancelled at once", () => {
    const runs = { data: [{ id: "r1", status: "running" }] };
    expect(guessConnectionChange({ action: "cancelRun", id: "r1", body: { reason: "x" } })(runs).data[0].status).toBe("cancelled");
  });

  it("takes a record source off when it is removed, but guesses nothing for a new one", () => {
    const out = guessConnectionChange({ action: "setRecordSource", id: "c1", body: { entityType: "machine", source: null } })(connection);
    expect(out.recordSources.map((s) => s.entityType)).toEqual(["part"]);
    expect(guessConnectionChange({ action: "setRecordSource", id: "c1", body: { entityType: "machine", source: { file: "x" } } })).toBeNull();
  });

  it("guesses nothing where only the server knows the answer", () => {
    for (const action of ["test", "ready", "activate", "update", "setCredential", "revokeCredential", "requestRun", "continueRun", "retryRows", "registerFile", "saveMapping", "connectionJob", "create"]) {
      expect(guessConnectionChange({ action, id: "c1", body: {} })).toBeNull();
    }
  });
});

describe("guessTemplateChange", () => {
  const t = { id: "t1", name: "Machines", archived: false };
  it("renames at once", () => {
    expect(guessTemplateChange({ action: "update", id: "t1", body: { name: " Machines v2 " } })([t])[0].name).toBe("Machines v2");
  });

  it("archiving takes it out of the lists in use and marks it archived elsewhere; bringing back does the opposite", () => {
    const inUse = ["api", "org", "o", "integrations", "templates", "all", "exclude"];
    const archivedList = ["api", "org", "o", "integrations", "templates", "all", "only"];
    const detailKey = ["api", "org", "o", "integrations", "template", "t1"];
    const archive = guessTemplateChange({ action: "archive", id: "t1", body: { reason: "old" } });
    expect(archive([t], inUse)).toEqual([]);
    expect(archive(t, detailKey).archived).toBe(true);
    const restore = guessTemplateChange({ action: "restore", id: "t1" });
    expect(restore([{ ...t, archived: true }], archivedList)).toEqual([]);
    expect(restore({ ...t, archived: true }, detailKey).archived).toBe(false);
  });

  it("guesses nothing for a duplicate, a new version or bringing back an old version", () => {
    for (const action of ["duplicate", "saveVersion", "restoreVersion", "create"]) expect(guessTemplateChange({ action, id: "t1", body: { name: "x" } })).toBeNull();
  });
});

describe("guessAgentChange", () => {
  it("renames an agent everywhere it shows", () => {
    const out = guessAgentChange({ action: "rename", id: "a1", body: { name: "Shop floor", location: null } })({ data: [{ id: "a1", name: "Old", location: "Rack 2" }] });
    expect(out.data[0]).toEqual({ id: "a1", name: "Shop floor", location: null });
  });

  it("shows an unused token and a waiting update cancelled", () => {
    expect(guessAgentChange({ action: "cancelRegistration", id: "g1" })({ data: [{ id: "g1", state: "waiting" }] }).data[0].state).toBe("cancelled");
    const agent = { id: "a1", updates: [{ id: "u1", status: "waiting" }] };
    expect(guessAgentChange({ action: "cancelUpdate", id: "u1" })(agent).updates[0].status).toBe("cancelled");
  });

  it("guesses nothing for checks, keys, diagnostics, updates, revoking, tokens or waking", () => {
    for (const action of ["ping", "rotateKeys", "diagnostics", "approveUpdate", "revoke", "register", "wake"]) expect(guessAgentChange({ action, id: "a1", body: {} })).toBeNull();
  });
});
