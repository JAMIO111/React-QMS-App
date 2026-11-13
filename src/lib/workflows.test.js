import { describe, expect, it } from "vitest";
import { contentChanged, describeAction, describeCondition, draftFromRule, draftProblems, emptyDraft, opsFor, ruleContent, workflowRecordPath } from "./workflows";

const trigger = {
  eventType: "ncr.created",
  label: "A non-conformance is raised",
  fields: [
    { key: "severity", label: "Severity", type: "ordered", options: [{ value: "minor", label: "Minor" }, { value: "major", label: "Major" }, { value: "critical", label: "Critical" }] },
    { key: "part_id", label: "Part", type: "ref", ref: "part" },
    { key: "category", label: "Category (code)", type: "text" },
  ],
};
const P = "11111111-2222-3333-4444-555555555555";
const U = "21111111-2222-3333-4444-555555555555";
const rule = {
  name: "Major NCs",
  description: null,
  trigger: "ncr.created",
  conditions: { all: [{ field: "severity", op: "gte", value: "major" }] },
  actions: [{ type: "task", assignee: { kind: "person", userId: U }, title: "Check", dueDays: 2 }],
};

describe("workflow rule builder helpers", () => {
  it("links records only by known kind and id", () => {
    expect(workflowRecordPath("capa", P)).toBe(`/CAPA/${P}/d0`);
    expect(workflowRecordPath("capa", "x")).toBeNull();
  });

  it("offers at least / at most only for ordered fields", () => {
    expect(opsFor(trigger.fields[0])).toContain("gte");
    expect(opsFor(trigger.fields[1])).not.toContain("gte");
  });

  it("describes conditions and actions in words", () => {
    expect(describeCondition({ field: "severity", op: "gte", value: "major" }, trigger)).toBe("Severity is at least Major");
    expect(describeCondition({ field: "part_id", op: "in", value: [P] }, trigger, { [P]: "P-100 · Bracket" })).toBe("Part is one of P-100 · Bracket");
    expect(describeCondition({ field: "category", op: "empty" }, trigger)).toBe("Category (code) is empty");
    expect(describeAction(rule.actions[0], { [U]: "Ann Smith" })).toBe("Give Ann Smith a task: “Check” (due in 2 days)");
    expect(describeAction({ type: "notify", recipients: [{ kind: "record_owner" }], message: "Look" })).toBe("Tell the record's owner: “Look”");
  });

  it("round-trips a saved rule and spots a change to what it does, not to its name", () => {
    const draft = draftFromRule(rule);
    expect(ruleContent(draft)).toEqual({ trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions });
    expect(contentChanged({ ...draft, name: "Other" }, rule)).toBe(false);
    expect(contentChanged({ ...draft, conditions: [{ field: "severity", op: "eq", value: "critical" }] }, rule)).toBe(true);
    expect(contentChanged({ ...draft, match: "any" }, rule)).toBe(true);
  });

  it("turns comma lists into values and leaves empty tests without one", () => {
    const content = ruleContent({ ...emptyDraft(), trigger: "ncr.created", conditions: [{ field: "category", op: "in", value: "PRODUCT, PROCESS ," }, { field: "part_id", op: "not_empty", value: "x" }] });
    expect(content.conditions.all).toEqual([{ field: "category", op: "in", value: ["PRODUCT", "PROCESS"] }, { field: "part_id", op: "not_empty" }]);
  });

  it("says what is still needed", () => {
    expect(draftProblems(emptyDraft(), undefined)).toEqual(["Give the rule a name", "Choose what starts the rule"]);
    const draft = { ...emptyDraft(), name: "x", trigger: "ncr.created", conditions: [{ field: "severity", op: "eq", value: "" }] };
    expect(draftProblems(draft, trigger)).toEqual(["Condition 1: say what severity to compare with", "Action 1: write the message"]);
    expect(draftProblems({ ...draftFromRule(rule) }, trigger)).toEqual([]);
    expect(draftProblems({ ...draftFromRule(rule), actions: [{ ...draftFromRule(rule).actions[0], dueDays: 400 }] }, trigger)).toEqual(["Action 1: due in 0 to 365 days"]);
  });
});
