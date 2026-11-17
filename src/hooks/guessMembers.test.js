import { describe, expect, it } from "vitest";
import { guessMembers } from "./useQmsApi";

const data = {
  data: [
    { membershipId: "m1", status: "active", roles: [{ assignmentId: "a1", roleId: "r1", roleName: "Viewer" }], departments: [{ id: "dm1", departmentId: "d1", name: "Goods-in", isPrimary: true }] },
    { membershipId: "m2", status: "active", roles: [], departments: [] },
  ],
};

describe("guessMembers (what the Users page shows before the server answers)", () => {
  it("adds a department chip with its names, primary when it is the first", () => {
    const next = guessMembers(data, { action: "addDepartment", membershipId: "m2", body: { departmentId: "d2" }, show: { name: "Machining", code: "MX", siteId: "s2", siteName: "Plant B" } });
    expect(next.data[1].departments).toEqual([expect.objectContaining({ departmentId: "d2", name: "Machining", siteId: "s2", isPrimary: true, id: expect.stringMatching(/^pending-/) })]);
    expect(next.data[0]).toBe(data.data[0]);
  });
  it("removes a department, moves the primary, adds and removes roles, changes status", () => {
    expect(guessMembers(data, { action: "endDepartment", departmentMembershipId: "dm1" }).data[0].departments).toEqual([]);
    const two = { data: [{ ...data.data[0], departments: [...data.data[0].departments, { id: "dm2", name: "MX", isPrimary: false }] }] };
    expect(guessMembers(two, { action: "setPrimaryDepartment", departmentMembershipId: "dm2" }).data[0].departments.map((d) => d.isPrimary)).toEqual([false, true]);
    expect(guessMembers(data, { action: "assign", membershipId: "m2", body: { roleId: "r2" }, show: { roleName: "Owner" } }).data[1].roles[0].roleName).toBe("Owner");
    expect(guessMembers(data, { action: "unassign", assignmentId: "a1" }).data[0].roles).toEqual([]);
    expect(guessMembers(data, { action: "status", membershipId: "m2", body: { status: "suspended" } }).data[1].status).toBe("suspended");
  });
  it("leaves the list alone for actions it cannot guess", () => {
    expect(guessMembers(data, { action: "invite", body: {} })).toBe(data);
  });
});
