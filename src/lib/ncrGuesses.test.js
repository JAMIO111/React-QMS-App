import { describe, expect, it } from "vitest";
import { containmentCancel, containmentDone, containmentReason, containmentReopen, costDelete, costRestore, dispositionCancel, lotRemove, lotRestore, ncrDelete, ncrRestore } from "./ncrGuesses";

const containment = () => ({ actions: [{ id: "a1", status: "open", doneNote: null, doneAt: null, cancelReason: null, quantityContained: null }], notNeededReason: null, resolved: false });
const key = (...rest) => ["api", "org", "o1", "ncr", ...rest];

describe("NC guesses", () => {
  it("marks a containment action done, cancelled and open again", () => {
    const done = containmentDone("a1", { note: "Sorted", quantityContained: 40 })(containment());
    expect(done.actions[0]).toMatchObject({ status: "done", doneNote: "Sorted", quantityContained: 40, doneAt: expect.any(String) });
    expect(containmentReopen("a1")(done).actions[0]).toMatchObject({ status: "open", doneNote: null, doneAt: null });
    expect(containmentCancel("a1", "Not needed")(containment()).actions[0]).toMatchObject({ status: "cancelled", cancelReason: "Not needed" });
  });

  it("sets and clears why no containment is needed, on that NC's containment only", () => {
    const data = containment();
    expect(containmentReason("n1", "Nothing shipped")(data, key("containment", "n1")).notNeededReason).toBe("Nothing shipped");
    expect(containmentReason("n1", "Nothing shipped")(data, key("containment", "n2"))).toBe(data);
    expect(containmentReason("n1", null)({ ...data, notNeededReason: "x" }, key("containment", "n1")).notNeededReason).toBeNull();
  });

  it("removes and restores an affected lot, and cancels a disposition", () => {
    const lots = { data: [{ id: "l1", removedAt: null, removedReason: null }] };
    const removed = lotRemove("l1", "Wrong lot")(lots);
    expect(removed.data[0]).toMatchObject({ removedReason: "Wrong lot", removedAt: expect.any(String) });
    expect(lotRestore("l1")(removed).data[0]).toMatchObject({ removedAt: null, removedReason: null });
    expect(dispositionCancel("d1", "Changed mind")({ data: [{ id: "d1", status: "proposed" }] }).data[0]).toMatchObject({ status: "cancelled", cancelReason: "Changed mind" });
  });

  it("deletes a cost line: gone where deleted lines are hidden, marked where they are shown; restores it", () => {
    const costs = () => ({ data: [{ id: "c1", deletedAt: null }, { id: "c2", deletedAt: null }], totals: {} });
    expect(costDelete("c1", "Typo")(costs(), key("costs", "n1", "exclude")).data.map((c) => c.id)).toEqual(["c2"]);
    const shown = costDelete("c1", "Typo")(costs(), key("costs", "n1", "include"));
    expect(shown.data[0]).toMatchObject({ deleteReason: "Typo", deletedAt: expect.any(String) });
    expect(costRestore("c1")(shown).data[0].deletedAt).toBeNull();
  });

  it("deletes an NC from register pages that hide deleted ones and restores it", () => {
    const page = () => ({ data: [{ id: "n1", deletedAt: null }, { id: "n2", deletedAt: null }], total: 2 });
    const gone = ncrDelete("n1", "Duplicate")(page(), key("list", { page: 1 }));
    expect(gone).toMatchObject({ total: 1, data: [{ id: "n2" }] });
    expect(ncrDelete("n1", "Duplicate")(page(), key("list", { deleted: "only" })).data[0]).toMatchObject({ deleteReason: "Duplicate" });
    const detail = ncrDelete("n1", "Duplicate")({ id: "n1", deletedAt: null, deleteReason: null }, key("detail", "n1"));
    expect(detail.deletedAt).toEqual(expect.any(String));
    expect(ncrRestore("n1")(detail)).toMatchObject({ deletedAt: null, deleteReason: null });
  });
});
