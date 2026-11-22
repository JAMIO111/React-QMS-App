import { describe, expect, it } from "vitest";
import { fieldsOwnedBySource, lockKey, lockMessage } from "./importLocks";

const version = (fields, writeMode = "add_update") => ({ settings: { writeMode }, fields });

describe("fieldsOwnedBySource", () => {
  it("lists source-wins fields, not Fortress-wins or review ones", () => {
    expect(fieldsOwnedBySource("machine", version([{ target: "code" }, { target: "name", ownership: "source_wins" }, { target: "description", ownership: "qms_wins" }, { target: "workCentre", ownership: "manual_review" }]))).toEqual(["code", "name"]);
  });
  it("is empty when the template only adds, or the kind is never locked", () => {
    expect(fieldsOwnedBySource("machine", version([{ target: "code" }], "add_only"))).toEqual([]);
    expect(fieldsOwnedBySource("nonconformance", version([{ target: "title" }]))).toEqual([]);
    expect(fieldsOwnedBySource("machine", undefined)).toEqual([]);
  });
  it("leaves out custom fields and a part's revision, which the guard does not cover", () => {
    expect(fieldsOwnedBySource("part", version([{ target: "partNumber" }, { target: "revision" }, { target: "cf_colour" }]))).toEqual(["partNumber"]);
  });
  it("counts update-only as updating", () => {
    expect(fieldsOwnedBySource("supplier", version([{ target: "email" }], "update_only"))).toEqual(["email"]);
  });
});

describe("words", () => {
  it("names the connection and how to get the field back", () => {
    expect(lockMessage("ERP")).toMatch(/Managed by ERP.*Fortress wins.*schedule off/);
    expect(lockMessage()).toMatch(/Managed by an import/);
  });
  it("maps form names to catalogue keys", () => {
    expect(lockKey("customerId")).toBe("customer");
  });
});
