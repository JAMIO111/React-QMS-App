import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { email: "ada@acme.test" } }) }));
vi.mock("../contexts/UserProvider", () => ({ useUser: () => ({ profile: { first_name: "Ada" } }) }));
vi.mock("../authService", () => ({ signOut: vi.fn() }));
vi.mock("./CreateOrganisationForm", () => ({ default: () => <p>organisation form</p> }));
vi.mock("./PendingInvitations", () => ({ default: () => <p>pending invitations</p> }));

import NoOrganisation from "./NoOrganisation";

const renderIt = (props) => render(<QueryClientProvider client={new QueryClient()}><NoOrganisation {...props} /></QueryClientProvider>);

describe("the first page after sign-up", () => {
  it("welcomes the person by name, shows where they are in getting started, and offers to start an organisation or accept an invitation", () => {
    renderIt({});
    expect(screen.getByRole("heading", { name: "Welcome, Ada" })).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Getting started" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(4);
    expect(within(steps).getByText("Name your organisation").closest("li")).toHaveAttribute("aria-current", "step");
    expect(within(steps).getByText("Create your account")).toBeInTheDocument();
    expect(screen.getByText("pending invitations")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Start your organisation" })).toBeInTheDocument();
    expect(screen.getByText("organisation form")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("explains a failure to load and offers nothing else", () => {
    renderIt({ error: new Error("API unreachable") });
    expect(screen.getByRole("alert")).toHaveTextContent("API unreachable");
    expect(screen.queryByText("organisation form")).toBeNull();
  });
});
