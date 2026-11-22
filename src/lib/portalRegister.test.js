import { describe, expect, it } from "vitest";
import { applyFilters, sortRows } from "./portalRegister";

const rows = [
  { id: "1", reference: "NC-1", title: "Cracked bar", stage: "open", detectedAt: "2026-11-02", lot: "L-1", viewed: true },
  { id: "2", reference: "NC-2", title: "Burrs", stage: "closed", detectedAt: "2026-10-01", lot: null, viewed: false },
  { id: "3", reference: "NC-10", title: "Wrong size", stage: "open", detectedAt: null, lot: "L-3", viewed: true },
];
const filters = [
  { type: "pills", key: "stage", label: "Stage", options: [], value: (r) => r.stage },
  { type: "dates", key: "detected", label: "Detected", value: (r) => r.detectedAt },
  { type: "switch", key: "attention", label: "Needs me", test: (r) => !r.viewed },
];
const run = (query, search = "") => applyFilters(rows, { filters, params: new URLSearchParams(query), search, searchText: (r) => `${r.reference} ${r.title} ${r.lot ?? ""}` }).map((r) => r.id);

describe("portal register filters", () => {
  it("keeps everything when nothing is chosen", () => expect(run("")).toEqual(["1", "2", "3"]));
  it("searches the words the page gives, ignoring case", () => {
    expect(run("", "burr")).toEqual(["2"]);
    expect(run("", "L-3")).toEqual(["3"]);
  });
  it("keeps the chosen values of a pill filter, any of several", () => {
    expect(run("f.stage=open")).toEqual(["1", "3"]);
    expect(run("f.stage=open,closed")).toEqual(["1", "2", "3"]);
  });
  it("keeps a date range inclusive at both ends and drops rows with no date once a range is set", () => {
    expect(run("d.detected.from=2026-10-01&d.detected.to=2026-10-31")).toEqual(["2"]);
    expect(run("d.detected.from=2026-11-02")).toEqual(["1"]);
    expect(run("d.detected.to=2026-11-30")).toEqual(["1", "2"]);
  });
  it("applies a switch only when it is on", () => {
    expect(run("s.attention=1")).toEqual(["2"]);
    expect(run("s.attention=0")).toEqual(["1", "2", "3"]);
  });
  it("combines the search and every filter", () => expect(run("f.stage=open&d.detected.from=2026-11-01", "crack")).toEqual(["1"]));
});

describe("portal register sorting", () => {
  const columns = [
    { id: "reference", accessorFn: (r) => r.reference },
    { id: "detectedAt", accessorFn: (r) => r.detectedAt },
  ];
  const ids = (sorting) => sortRows(rows, sorting, columns).map((r) => r.id);
  it("sorts numbers inside text the way people read them (NC-2 before NC-10)", () => expect(ids([{ id: "reference", desc: false }])).toEqual(["1", "2", "3"]));
  it("reverses on descending", () => expect(ids([{ id: "reference", desc: true }])).toEqual(["3", "2", "1"]));
  it("puts rows with no value last whichever way it sorts", () => {
    expect(ids([{ id: "detectedAt", desc: false }])).toEqual(["2", "1", "3"]);
    expect(ids([{ id: "detectedAt", desc: true }])).toEqual(["1", "2", "3"]);
  });
  it("leaves the order alone with no sort or an unknown column", () => {
    expect(ids([])).toEqual(["1", "2", "3"]);
    expect(ids([{ id: "nope", desc: false }])).toEqual(["1", "2", "3"]);
  });
});
