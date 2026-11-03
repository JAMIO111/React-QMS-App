import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Dashboard from "./Dashboard";

vi.mock("@/contexts/UserProvider", () => ({
  useUser: () => ({ profile: { first_name: "Sam" } }),
}));

describe("Dashboard", () => {
  it("greets the user and links to each NC register", () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sam");
    expect(screen.getByRole("link", { name: /internal/i })).toHaveAttribute("href", "/Non-Conformance/Internal");
    expect(screen.getByRole("link", { name: /customer/i })).toHaveAttribute("href", "/Non-Conformance/Customer");
    expect(screen.getByRole("link", { name: /supplier/i })).toHaveAttribute("href", "/Non-Conformance/Supplier");
  });
});
