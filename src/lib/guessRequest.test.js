import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { addToList, appendRow, changeRecord, defaultGuess, deletedFilterOf, myName, patchFields, requestGuessHandlers, softDelete } from "./guessRequest";
import { isPending } from "./optimistic";
import { guessAlertAcknowledged } from "../hooks/useSpc";
import { guessJobLinks } from "../hooks/useJobs";
import { guessAbandoned, guessAcknowledged } from "../hooks/useInspection";
import { guessFeatureMaps, guessImport, guessProfiles } from "../hooks/useMeasurementImports";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

describe("patchFields", () => {
  it("changes the fields the record has, sets and clears values, and leaves the version and other kinds alone", () => {
    const rec = { id: A, name: "Old", ownerId: null, notes: "x", count: 1, rowVersion: "v1", tags: [] };
    expect(patchFields(rec, { name: "New", ownerId: B, notes: null, count: "2", rowVersion: "v9", tags: "a", missing: 1 })).toEqual({
      id: A,
      name: "New",
      ownerId: B,
      notes: null,
      count: 1,
      rowVersion: "v1",
      tags: [],
    });
  });

  it("returns the same object when nothing changes", () => {
    const rec = { id: A, name: "Same" };
    expect(patchFields(rec, { name: "Same" })).toBe(rec);
  });
});

describe("defaultGuess", () => {
  const cache = { data: [{ id: A, active: true, name: "Gauge" }, { id: B, active: true }], total: 2 };

  it("switches a record off everywhere it is cached for a flat PATCH", () => {
    const guess = defaultGuess({ path: `/gauge-types/${A}`, method: "PATCH", body: { active: false } });
    expect(guess(cache).data[0]).toEqual({ id: A, active: false, name: "Gauge" });
  });

  it("drops a record for a DELETE, and guesses nothing for a POST or a nested body", () => {
    expect(defaultGuess({ path: `/part-customers/${A}`, method: "DELETE" })(cache).data.map((r) => r.id)).toEqual([B]);
    expect(defaultGuess({ path: "/gauges", method: "POST", body: { assetNumber: "G-1" } })).toBeNull();
    expect(defaultGuess({ path: `/calibrations/${A}`, method: "PATCH", body: { readings: [] } })).toBeNull();
  });
});

describe("list guesses", () => {
  it("appendRow adds to matching lists and keyset pages only, counting it", () => {
    const row = { id: "pending-1" };
    expect(appendRow(["p1", "characteristics"], row)({ data: [], total: 0 }, ["api", "org", "o", "calibration", "gauge", "p1", "characteristics", false])).toEqual({ data: [row], total: 1 });
    expect(appendRow(["p1", "characteristics"], row)({ data: [] }, ["api", "org", "o", "calibration", "gauge", "p2", "characteristics"])).toEqual({ data: [] });
    expect(appendRow(["x"], row, { first: true })({ pages: [{ data: [{ id: 1 }] }, { data: [] }] }, ["x"]).pages[0].data).toEqual([row, { id: 1 }]);
  });

  it("addToList and changeRecord change the owning record wherever it is", () => {
    const plan = { id: A, applicability: [{ id: B }] };
    expect(addToList(A, "applicability", { id: "pending-1" })({ plan }).plan.applicability).toHaveLength(2);
    expect(changeRecord(A, (p) => ({ ...p, title: "T" }))([plan])[0].title).toBe("T");
  });

  it("softDelete takes a deleted record out of lists without deleted ones, and a restored one out of 'deleted only' lists", () => {
    const list = { data: [{ id: A, deletedAt: null }, { id: B, deletedAt: null }], total: 2 };
    const at = "2026-11-17T10:00:00Z";
    expect(deletedFilterOf(["api", "org", "o", "calibration", "gauges", { deleted: undefined }])).toBe("exclude");
    expect(softDelete(A, at)(list, ["calibration", "gauges", { deleted: undefined }])).toEqual({ data: [{ id: B, deletedAt: null }], total: 1 });
    expect(softDelete(A, at)(list, ["calibration", "gauges", { deleted: "include" }]).data[0].deletedAt).toBe(at);
    expect(softDelete(A, at)({ id: A, deletedAt: null }, ["calibration", "gauge", A])).toEqual({ id: A, deletedAt: at });
    const deletedOnly = { data: [{ id: A, deletedAt: at }], total: 1 };
    expect(softDelete(A, null)(deletedOnly, ["calibration", "gauges", { deleted: "only" }])).toEqual({ data: [], total: 0 });
    expect(softDelete(A, null)(deletedOnly, ["calibration", "gauge", A, "calibrations", "include"]).data[0].deletedAt).toBeNull();
  });
});

describe("requestGuessHandlers", () => {
  it("changes the cache before the request and puts it back when the request fails", async () => {
    const client = new QueryClient();
    const key = ["api", "org", "o", "master", "machines", {}];
    const before = { data: [{ id: A, name: "Lathe", active: true }] };
    client.setQueryData(key, before);
    const handlers = requestGuessHandlers(client, ["api", "org", "o", "master"]);
    const context = await handlers.onMutate({ path: `/machines/${A}`, method: "PATCH", body: { active: false } });
    expect(context.optimistic).toBe(true);
    expect(client.getQueryData(key).data[0].active).toBe(false);
    handlers.onError(new Error("refused"), {}, context);
    expect(client.getQueryData(key)).toEqual(before);
  });

  it("uses a request's own guess", async () => {
    const client = new QueryClient();
    const key = ["api", "org", "o", "master", "detail", "/part-families/x"];
    client.setQueryData(key, { id: A, parts: [{ id: B }] });
    const handlers = requestGuessHandlers(client, ["api", "org", "o", "master"]);
    await handlers.onMutate({ path: `/part-families/${A}/parts`, body: { remove: [B] }, guess: changeRecord(A, (f) => ({ ...f, parts: [] })) });
    expect(client.getQueryData(key).parts).toEqual([]);
  });

  it("myName reads the cached profile, else says You", () => {
    const client = new QueryClient();
    expect(myName(client)).toBe("You");
    client.setQueryData(["api", "me", "u1"], { profile: { firstName: "Ada", surname: "Lovelace" } });
    expect(myName(client)).toBe("Ada Lovelace");
  });
});

describe("module guesses", () => {
  it("an acknowledged SPC alert leaves the open list, shows as acknowledged elsewhere, and the open count drops", () => {
    const list = { data: [{ id: A, status: "open" }, { id: B, status: "open" }], openCount: 2 };
    const guess = guessAlertAcknowledged({ id: A, note: "Tool changed", by: "Ada", at: "t" });
    expect(guess(list, ["api", "org", "o", "spc", "alerts", "open", undefined])).toEqual({ data: [{ id: B, status: "open" }], openCount: 1 });
    expect(guess(list, ["api", "org", "o", "spc", "alerts", "all", undefined]).data[0]).toEqual({
      id: A,
      status: "acknowledged",
      note: "Tool changed",
      acknowledgedAt: "t",
      acknowledgedBy: { name: "Ada" },
    });
  });

  it("a failed reading shows its acknowledgement, and an abandoned inspection its status", () => {
    const inspection = { id: A, status: "in_progress", abandonReason: null, measurements: [{ id: B, acknowledgement: null }] };
    expect(guessAcknowledged(B, "Sorted", "Ada", "t")(inspection).measurements[0].acknowledgement).toEqual({ note: "Sorted", at: "t", by: { name: "Ada" } });
    expect(guessAbandoned(A, "Machine down")(inspection)).toMatchObject({ status: "abandoned", abandonReason: "Machine down" });
  });

  it("a job's chosen order shows at once with the picker's name, and clearing removes it", () => {
    const job = { id: A, links: { productionOrder: null, lot: { id: "l1", lotNumber: "L-1" }, serial: null } };
    expect(guessJobLinks(job, { productionOrderId: "o1" }, { productionOrder: { id: "o1", orderNumber: "WO-1" } }).links.productionOrder).toEqual({ id: "o1", orderNumber: "WO-1" });
    expect(guessJobLinks(job, { lotId: null }).links.lot).toBeNull();
  });

  it("measurement profiles retire, come back and show a change; feature matches are added and ended", () => {
    const profiles = { data: [{ id: A, name: "Bench", active: true, retiredReason: null, currentVersion: 2, description: null }] };
    expect(guessProfiles(profiles, { action: "retire", id: A, reason: "Old CMM" }).data[0]).toMatchObject({ active: false, retiredReason: "Old CMM" });
    expect(guessProfiles(profiles, { action: "update", id: A, body: { name: "Bench 2", settings: {} } }).data[0]).toMatchObject({ name: "Bench 2", currentVersion: 3 });
    expect(guessProfiles(profiles, { action: "create", body: {} })).toBe(profiles);

    const maps = { data: [{ id: B, featureName: "OD", characteristicKey: "OLD", profile: null }] };
    const saved = guessFeatureMaps(maps, { action: "save", partId: "p1", body: { featureName: "od", characteristicKey: "DIA", profileId: null } }, ["api", "org", "o", "measurement-imports", "feature-maps", "p1"]);
    expect(saved.data).toHaveLength(1);
    expect(saved.data[0]).toMatchObject({ featureName: "od", characteristicKey: "DIA" });
    expect(isPending(saved.data[0].id)).toBe(true);
    expect(guessFeatureMaps(maps, { action: "end", id: B }).data).toEqual([]);
  });

  it("a measurement file's differences are confirmed, and a discarded file says so", () => {
    const detail = { id: A, status: "previewed", mismatchesConfirmedAt: null, mismatchesConfirmedBy: null, discardReason: null };
    expect(guessImport(detail, { action: "confirm", id: A }, "Ada", "t")).toMatchObject({ mismatchesConfirmedAt: "t", mismatchesConfirmedBy: "Ada" });
    expect(guessImport(detail, { action: "discard", id: A, reason: "Wrong program" }, "Ada")).toMatchObject({ status: "discarded", discardReason: "Wrong program" });
    expect(guessImport(detail, { action: "apply", id: A }, "Ada")).toBe(detail);
  });
});
