import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let permissions = [];
const mutate = vi.fn();
const data = {
  categories: [
    { id: "c1", key: "inspection", label: "Inspection", description: null, sequence: 1, active: true, skills: 2 },
    { id: "c2", key: "other", label: "Other", description: null, sequence: 2, active: true, skills: 0 },
  ],
  skills: [
    { id: "s1", code: "CMM", name: "CMM operation", category: { id: "c1", label: "Inspection" }, description: null, refreshMonths: 12, active: true, retiredReason: null, positions: 1 },
    { id: "s2", code: "VIS", name: "Visual inspection", category: { id: "c1", label: "Inspection" }, description: null, refreshMonths: null, active: true, retiredReason: null, positions: 0 },
    { id: "s3", code: "OLD", name: "Old gauge", category: { id: "c1", label: "Inspection" }, description: null, refreshMonths: null, active: false, retiredReason: "Gauge scrapped", positions: 0 },
  ],
  positions: [
    { id: "p1", code: "INSP", name: "CMM inspector", description: null, active: true, retiredReason: null, skills: [{ skillId: "s1", code: "CMM", name: "CMM operation", category: "Inspection", requiredLevel: 3, skillActive: true }] },
  ],
};
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../hooks/useCompetence", () => ({
  useCompetenceCategories: () => ({ data: { data: data.categories }, isLoading: false }),
  useCompetenceSkills: () => ({ data: { data: data.skills }, isLoading: false }),
  useCompetencePositions: () => ({ data: { data: data.positions }, isLoading: false }),
  useCompetenceMutation: () => ({ mutate, isPending: false, error: null }),
}));

import SettingsCompetence from "./SettingsCompetence";

beforeEach(() => {
  mutate.mockReset();
  permissions = ["competence.read", "competence.manage"];
});

describe("Settings → Competence", () => {
  it("lists categories, skills by category with retired ones folded away, and positions with what they require", () => {
    render(<SettingsCompetence />);
    expect(screen.getByRole("list", { name: "Skill categories" })).toBeInTheDocument();
    const inspection = screen.getByRole("region", { name: "Inspection" });
    expect(within(inspection).getByText(/CMM operation/)).toBeInTheDocument();
    expect(within(inspection).getByText("Every year")).toBeInTheDocument();
    expect(within(inspection).getByText("No refresh")).toBeInTheDocument();
    expect(screen.getByText("Retired skills (1)")).toBeInTheDocument();
    expect(screen.getByText("CMM operation 3")).toBeInTheDocument();
  });

  it("adds a skill with its category and refresh interval", async () => {
    render(<SettingsCompetence />);
    await userEvent.click(screen.getByRole("button", { name: /Add skill/ }));
    await userEvent.type(screen.getByLabelText("Code"), "GAUGE");
    await userEvent.type(screen.getByLabelText("Name"), "Gauge handling");
    await userEvent.click(screen.getByLabelText("Category"));
    await userEvent.click(await screen.findByRole("option", { name: /Inspection/ }));
    await userEvent.type(screen.getByLabelText("Reassess every (months)"), "6");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith({ action: "createSkill", body: { name: "Gauge handling", categoryId: "c1", description: null, refreshMonths: 6, code: "GAUGE" } }, expect.any(Object));
  });

  it("refuses a refresh interval outside 1 to 120 before sending", async () => {
    render(<SettingsCompetence />);
    await userEvent.click(screen.getByRole("button", { name: /Add skill/ }));
    await userEvent.type(screen.getByLabelText("Reassess every (months)"), "500");
    expect(screen.getByText(/whole number from 1 to 120/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("retires a skill only with a reason, and brings a retired one back", async () => {
    render(<SettingsCompetence />);
    await userEvent.click(screen.getAllByRole("button", { name: "Retire" })[0]);
    const dialog = within(screen.getByRole("dialog"));
    const save = dialog.getByRole("button", { name: "Retire" });
    expect(save).toBeDisabled();
    await userEvent.type(dialog.getByLabelText("Why is it retired?"), "Not used");
    await userEvent.click(save);
    expect(mutate).toHaveBeenCalledWith({ action: "retireSkill", id: "s1", body: { reason: "Not used" } }, expect.any(Object));
    mutate.mockReset();
    await userEvent.click(screen.getByText("Retired skills (1)"));
    await userEvent.click(screen.getAllByRole("button", { name: "Bring back" })[0]);
    expect(mutate).toHaveBeenCalledWith({ action: "reactivateSkill", id: "s3" }, expect.any(Object));
  });

  it("sets what a position requires as a whole list", async () => {
    render(<SettingsCompetence />);
    await userEvent.click(screen.getByRole("button", { name: "Required skills" }));
    const list = screen.getByRole("list", { name: "Required skills" });
    expect(within(list).getByText("CMM operation")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Add a skill"));
    await userEvent.click(await screen.findByRole("option", { name: /Visual inspection/ }));
    expect(within(screen.getByRole("list", { name: "Required skills" })).getByText("Visual inspection")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith(
      { action: "setPositionSkills", id: "p1", body: { skills: [{ skillId: "s1", requiredLevel: 3 }, { skillId: "s2", requiredLevel: 3 }] } },
      expect.any(Object),
    );
  });

  it("is read-only without competence.manage", () => {
    permissions = ["competence.read"];
    render(<SettingsCompetence />);
    expect(screen.queryByRole("button", { name: /Add skill/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retire" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Required skills" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Inspection is in use" })).toBeDisabled();
  });
});
