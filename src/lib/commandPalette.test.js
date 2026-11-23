import { beforeEach, describe, expect, it } from "vitest";
import {
  RECENT_LIMIT,
  addRecent,
  clearRecents,
  highlight,
  isRecordAddress,
  loadRecents,
  pageEntries,
  recordPath,
  routeActions,
  scoreEntry,
  searchEntries,
  statusWords,
} from "./commandPalette";

const everything = () => true;
const only = (...allowed) => (permission) => !permission || [].concat(permission).some((p) => allowed.includes(p));

describe("pages", () => {
  it("lists every page of the side menu and Settings the person may see, with the module as its hint", () => {
    const pages = pageEntries({ canSee: everything });
    const register = pages.find((p) => p.to === "/Non-Conformance/Register");
    expect(register).toMatchObject({ label: "Register", hint: "Non-Conformance", group: "pages" });
    expect(pages.find((p) => p.to === "/Non-Conformance")).toMatchObject({ label: "Non-Conformance dashboard" });
    expect(pages.find((p) => p.to === "/Settings/Security")).toMatchObject({ label: "Security", hint: "Settings" });
    expect(pages.find((p) => p.to === "/Dashboard")).toMatchObject({ label: "Dashboard", hint: null });
  });

  it("leaves out what the menu hides: a missing permission, a module the plan lacks, a setting that is off", () => {
    const pages = pageEntries({ canSee: only("ncr.read", "production.read"), hasModule: (m) => m !== "nonconformance", productionSettings: { useLotsAndSerials: false } });
    const paths = pages.map((p) => p.to);
    expect(paths).not.toContain("/Non-Conformance/Register");
    expect(paths).not.toContain("/Calibration/Gauges");
    expect(paths).toContain("/Production/Orders");
    expect(paths).not.toContain("/Production/Lots");
    expect(paths).not.toContain("/Settings/Security");
    expect(paths).toContain("/Settings/Organisation");
  });

  it("offers only the actions the person has the right for", () => {
    expect(routeActions({ canSee: everything }).map((a) => a.id)).toContain("action:new-ncr");
    const few = routeActions({ canSee: only() }).map((a) => a.id);
    expect(few).toEqual(["action:my-reminders", "action:my-tasks"]);
  });
});

describe("matching", () => {
  const entries = [
    { id: "a", label: "Register", hint: "Non-Conformance" },
    { id: "b", label: "Risk register", hint: "Risk" },
    { id: "c", label: "Gauges", hint: "Calibration", keywords: "instrument micrometer" },
  ];

  it("needs every word to be found, in the label, the module or the keywords", () => {
    expect(searchEntries(entries, "register").map((e) => e.id)).toEqual(["a", "b"]);
    expect(searchEntries(entries, "non-conformance register").map((e) => e.id)).toEqual(["a"]);
    expect(searchEntries(entries, "micrometer").map((e) => e.id)).toEqual(["c"]);
    expect(searchEntries(entries, "register zzz")).toEqual([]);
  });

  it("puts a label that starts with the word first, then a word that starts a word, then the rest", () => {
    expect(scoreEntry(entries[0], "reg")).toBe(0);
    expect(scoreEntry(entries[1], "reg")).toBe(1);
    expect(scoreEntry({ label: "Subregister" }, "reg")).toBe(2);
    expect(scoreEntry(entries[2], "calib")).toBe(3);
    expect(scoreEntry(entries[0], "")).toBe(0);
  });

  it("ignores case and accents", () => {
    expect(scoreEntry({ label: "Café report" }, "CAFE")).toBe(0);
  });

  it("marks the words typed and the pieces always join back into the text", () => {
    const pieces = highlight("Non-Conformance register", "conf reg");
    expect(pieces.filter((p) => p.match).map((p) => p.text)).toEqual(["Conf", "reg"]);
    expect(pieces.map((p) => p.text).join("")).toBe("Non-Conformance register");
    expect(highlight("Gauges", "")).toEqual([{ text: "Gauges", match: false }]);
    expect(highlight("Gauges", "xyz")).toEqual([{ text: "Gauges", match: false }]);
  });
});

describe("recently opened", () => {
  const key = "fortress.recent.u.o";
  beforeEach(() => window.localStorage.clear());

  it("keeps the newest first, one entry per address, and no more than eight", () => {
    addRecent(key, { path: "/a", label: "A" });
    addRecent(key, { path: "/b", label: "B" });
    addRecent(key, { path: "/a", label: "A again" });
    expect(loadRecents(key).map((r) => r.label)).toEqual(["A again", "B"]);
    for (let i = 0; i < 12; i += 1) addRecent(key, { path: `/p${i}`, label: `P${i}` });
    expect(loadRecents(key)).toHaveLength(RECENT_LIMIT);
    expect(loadRecents(key)[0].path).toBe("/p11");
  });

  it("can be cleared, and a damaged store reads as empty", () => {
    addRecent(key, { path: "/a", label: "A" });
    clearRecents(key);
    expect(loadRecents(key)).toEqual([]);
    window.localStorage.setItem(key, "{not json");
    expect(loadRecents(key)).toEqual([]);
    window.localStorage.setItem(key, JSON.stringify([{ nope: 1 }, { path: "/ok", label: "Ok" }]));
    expect(loadRecents(key)).toEqual([{ path: "/ok", label: "Ok" }]);
  });

  it("remembers only addresses that end in an id", () => {
    expect(isRecordAddress("/Parts/0b6f3c64-1111-4222-8333-444455556666")).toBe(true);
    expect(isRecordAddress("/Parts")).toBe(false);
  });
});

describe("records", () => {
  it("opens each kind on its own screen", () => {
    expect(recordPath("ncr", "x")).toBe("/Non-Conformance/Register/x");
    expect(recordPath("capa", "x")).toBe("/CAPA/x");
    expect(recordPath("part", "x")).toBe("/Parts/x");
    expect(recordPath("supplier", "x")).toBe("/Suppliers/x");
    expect(recordPath("gauge", "x")).toBe("/Calibration/Gauges/x");
    expect(recordPath("inspection", "x")).toBe("/Inspections/x");
    expect(recordPath("document", "x")).toBe("/Documentation/Documents/x");
  });

  it("says a status in words", () => {
    expect(statusWords("awaiting_closure")).toBe("Awaiting closure");
    expect(statusWords(null)).toBe("");
  });
});
