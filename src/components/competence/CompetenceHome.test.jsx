import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

let permissions = [];
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../hooks/useCompetence", () => ({
  useCompetenceSkills: () => ({
    data: { data: [{ id: "s1", code: "CMM", name: "CMM operation", category: { id: "c1", label: "Inspection" }, refreshMonths: 12, active: true }] },
    isLoading: false,
  }),
  useCompetencePositions: () => ({
    data: { data: [{ id: "p1", code: "INSP", name: "CMM inspector", skills: [{ name: "CMM operation", requiredLevel: 3 }] }] },
    isLoading: false,
  }),
}));

import CompetenceHome from "./CompetenceHome";

const show = () => render(<MemoryRouter><CompetenceHome /></MemoryRouter>);

describe("Competence home", () => {
  it("shows the skills by category and what each position requires, and says more is coming", () => {
    permissions = ["competence.read"];
    show();
    expect(screen.getByRole("heading", { name: "Competence" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Inspection" })).toHaveTextContent("CMM operation");
    expect(screen.getByText("CMM operation 3")).toBeInTheDocument();
    expect(screen.getByText("More is coming")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Set up skills and positions" })).not.toBeInTheDocument();
  });

  it("offers set-up to people who manage competence", () => {
    permissions = ["competence.read", "competence.manage"];
    show();
    expect(screen.getByRole("link", { name: "Set up skills and positions" })).toHaveAttribute("href", "/Settings/Data-Management?tab=competence");
  });
});
