import { describe, expect, it } from "vitest";
import { guessSample } from "./useInspection";
import { isPending } from "../lib/optimistic";

const inspection = { id: "i1", samples: [{ id: "s1", sampleNumber: 1 }], measurements: [{ id: "m1", sampleId: "s1", requirementId: "q1", valueNumeric: "25.00", result: "pass" }] };

describe("guessSample (a sample shows at once, the database decides pass or fail)", () => {
  it("adds the next sample with its readings and no result yet", () => {
    const detail = guessSample("i1", { unitReference: "U2", readings: [{ requirementId: "q1", valueNumeric: "25.10" }, { requirementId: "q2", valuePass: true }] })(inspection);
    expect(detail.samples).toHaveLength(2);
    const added = detail.samples[1];
    expect(added.sampleNumber).toBe(2);
    expect(added.unitReference).toBe("U2");
    expect(isPending(added.id)).toBe(true);
    const fresh = detail.measurements.filter((m) => m.sampleId === added.id);
    expect(fresh.map((m) => [m.requirementId, m.result])).toEqual([["q1", null], ["q2", null]]);
    expect(fresh.every((m) => isPending(m.id))).toBe(true);
  });
  it("leaves other cached data alone", () => {
    const other = { id: "i9", samples: [], measurements: [] };
    expect(guessSample("i1", { readings: [] })(other)).toBe(other);
  });
});
