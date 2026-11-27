import { describe, expect, it } from "vitest";
import { groupPermissions, groupState, highestSeat, holdersWords, roleProblems, viewOnly } from "./roles";

const permissions = [
  { code: "ncr.read", description: "View non-conformances", module: "Nonconformance", needs: "observer" },
  { code: "ncr.create", description: "Raise non-conformances", module: "Nonconformance", needs: "contributor" },
  { code: "ncr.update", description: "Edit non-conformances", module: "Nonconformance", needs: "controller" },
  { code: "members.manage", description: "Invite and manage people", module: "Administration", needs: null },
  { code: "roles.manage", description: "Manage roles", module: "Administration", needs: null },
  { code: "audit.read", description: "View the audit trail", module: "Analytics", needs: "observer" },
];

describe("groupPermissions", () => {
  it("groups by module, leaves out what a custom role may not carry and puts Administration last", () => {
    const groups = groupPermissions(permissions);
    expect(groups.map((g) => g.module)).toEqual(["Nonconformance", "Analytics", "Administration"]);
    expect(groups.flatMap((g) => g.items.map((p) => p.code))).not.toContain("roles.manage");
  });
});

describe("groupState and viewOnly", () => {
  const nc = groupPermissions(permissions)[0];
  it("says none, some or all of a group is chosen", () => {
    expect(groupState(nc, new Set())).toBe("none");
    expect(groupState(nc, new Set(["ncr.read"]))).toBe("some");
    expect(groupState(nc, new Set(["ncr.read", "ncr.create", "ncr.update"]))).toBe("all");
  });
  it("finds the viewing permissions of a group", () => {
    expect(viewOnly(nc).map((p) => p.code)).toEqual(["ncr.read"]);
  });
});

describe("roleProblems", () => {
  it("needs a name and at least one permission", () => {
    expect(roleProblems({ name: "  ", selected: new Set() })).toEqual(["Give the role a name.", "Choose at least one permission."]);
    expect(roleProblems({ name: "Tech", selected: new Set(["ncr.read"]) })).toEqual([]);
    expect(roleProblems({ name: "x".repeat(61), selected: new Set(["ncr.read"]) })).toEqual(["The role name is up to 60 characters."]);
  });
});

describe("words", () => {
  it("counts holders", () => {
    expect(holdersWords(0)).toBe("Nobody holds it yet");
    expect(holdersWords(1)).toBe("1 person holds it");
    expect(holdersWords(4)).toBe("4 people hold it");
  });
  it("names the highest seat a choice asks for", () => {
    expect(highestSeat(permissions, new Set())).toBeNull();
    expect(highestSeat(permissions, new Set(["ncr.read"]))).toBe("observer");
    expect(highestSeat(permissions, new Set(["ncr.read", "ncr.update"]))).toBe("controller");
    expect(highestSeat(permissions, new Set(["members.manage"]))).toBeNull();
  });
});
