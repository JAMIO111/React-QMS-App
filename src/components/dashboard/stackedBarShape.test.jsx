import { describe, expect, it } from "vitest";
import { stackedBarShape } from "./DashboardParts";

const KEYS = ["pass", "fail", "pending"];
const shape = stackedBarShape(KEYS);
const radiusOf = (dataKey, payload) => shape({ dataKey, payload, x: 0, y: 0, width: 10, height: 20, fill: "red" }).props.radius;

describe("stackedBarShape", () => {
  it("rounds the top of the last series when it has something in it", () => {
    const row = { pass: 3, fail: 2, pending: 1 };
    expect(radiusOf("pending", row)).toEqual([4, 4, 0, 0]);
    expect(radiusOf("fail", row)).toBe(0);
    expect(radiusOf("pass", row)).toBe(0);
  });

  it("rounds the topmost segment that has something when the last series is empty", () => {
    const row = { pass: 3, fail: 2, pending: 0 };
    expect(radiusOf("fail", row)).toEqual([4, 4, 0, 0]);
    expect(radiusOf("pass", row)).toBe(0);
    expect(radiusOf("pending", row)).toEqual([4, 4, 0, 0]); // nothing is drawn for an empty segment
    expect(radiusOf("pass", { pass: 5, fail: 0, pending: 0 })).toEqual([4, 4, 0, 0]);
    expect(radiusOf("pass", { pass: 5 })).toEqual([4, 4, 0, 0]); // a missing series counts as empty
  });

  it("gives the same shape for the same series, so a chart does not remount its bars", () => {
    expect(stackedBarShape(["a", "b"])).toBe(stackedBarShape(["a", "b"]));
    expect(stackedBarShape(["a", "b"])).not.toBe(stackedBarShape(["b", "a"]));
  });
});
