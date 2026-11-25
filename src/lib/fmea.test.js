import { describe, expect, it } from "vitest";
import { linksBody, linkWords, personValue, revisionName, sameLink, teamBody, teamProblem } from "./fmea";

describe("the team", () => {
  it("says what stops it being saved", () => {
    expect(teamProblem([{ person: "", role: "lead" }])).toMatch(/Choose a person/);
    expect(teamProblem([{ person: "u:1", role: "lead" }, { person: "u:1", role: "quality" }])).toMatch(/once/);
    expect(teamProblem([{ person: "u:1", role: "lead" }, { person: "e:2", role: "lead" }])).toMatch(/one team lead/);
    expect(teamProblem([{ person: "u:1", role: "lead" }, { person: "e:2", role: "process" }])).toBeNull();
  });

  it("sends members and employees the way the API names them", () => {
    expect(teamBody([{ person: "u:abc", role: "lead" }, { person: "e:def", role: "process" }])).toEqual([
      { userId: "abc", role: "lead" },
      { employeeId: "def", role: "process" },
    ]);
    expect(personValue({ kind: "employee", personId: "def" })).toBe("e:def");
    expect(personValue({ kind: "member", personId: "abc" })).toBe("u:abc");
  });
});

describe("what it covers", () => {
  it("sends records by id and operations by code, and tells the same one twice", () => {
    expect(linksBody([{ kind: "part", id: "p1" }, { kind: "operation_code", code: "OP10" }])).toEqual([{ kind: "part", id: "p1" }, { kind: "operation_code", code: "OP10" }]);
    expect(sameLink({ kind: "operation_code", code: "op10" }, { kind: "operation_code", code: "OP10" })).toBe(true);
    expect(sameLink({ kind: "part", id: "p1" }, { kind: "part_family", id: "p1" })).toBe(false);
  });

  it("names a record the reader cannot open in plain words", () => {
    expect(linkWords({ kind: "part", readable: false })).toBe("a record you cannot open");
    expect(linkWords({ kind: "part", readable: true, reference: "BR-1", name: "Bracket" })).toBe("BR-1 · Bracket");
    expect(linkWords({ kind: "operation_code", code: "OP10" })).toBe("OP10");
  });
});

describe("revision names", () => {
  it("uses the letter once there is one", () => {
    expect(revisionName({ letter: "B", sequence: 2 })).toBe("rev B");
    expect(revisionName({ letter: null, sequence: 2 })).toBe("draft 2");
  });
});
