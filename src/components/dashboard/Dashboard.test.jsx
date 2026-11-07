import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

let access;
let permissions;
let wizard;
const KEYS = ["organisation", "plan", "details", "sites", "security", "team", "review"];
const steps = (statuses = {}) =>
  KEYS.map((key) => ({ key, status: statuses[key] ?? (key === "organisation" || key === "sites" ? "done" : "pending"), required: key === "organisation" || key === "sites" || key === "plan", auto: false }));

vi.mock("@/contexts/UserProvider", () => ({ useUser: () => ({ profile: { first_name: "Sam" } }) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisation: { id: "o1", name: "Acme Ltd" } }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  useOrganisationAccess: () => access,
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
}));
let checklist;
vi.mock("../../hooks/useOnboarding", () => ({
  useOnboarding: ({ enabled }) => ({ data: enabled ? wizard : undefined }),
  useGoLiveChecklist: ({ enabled }) => ({ data: enabled ? checklist : undefined }),
}));

import Dashboard from "./Dashboard";
import { deferSetup, setupDeferred } from "../../lib/onboarding";

const renderIt = () => render(<MemoryRouter><Dashboard /></MemoryRouter>);

beforeEach(() => {
  access = { accessState: "open", onboarding: "in_progress" };
  permissions = ["organisation.manage"];
  wizard = { completedAt: null, currentStep: "plan", canFinish: false, steps: steps() };
  sessionStorage.clear();
});

describe("Dashboard", () => {
  it("greets the user and no longer shows the three non-conformance link cards", () => {
    renderIt();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sam");
    for (const name of [/internal non-conformances/i, /customer non-conformances/i, /supplier non-conformances/i]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
  });
});

describe("the set-up progress card", () => {
  it("shows how far along the set-up is, what is next and what is still needed, with the way back in", () => {
    renderIt();
    const card = screen.getByRole("region", { name: "Set-up progress" });
    expect(within(card).getByRole("heading", { name: "Finish setting up Acme Ltd" })).toBeInTheDocument();
    expect(card).toHaveTextContent("2 of 7 steps done");
    expect(within(card).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "29");
    expect(card).toHaveTextContent("Next: Plan and seats.");
    expect(card).toHaveTextContent("Still needed before you can finish: Plan & seats.");
    expect(within(card).getByRole("link", { name: "Continue set-up" })).toHaveAttribute("href", "/setup/plan");
  });

  it("links to every step, marks the current one and the finished ones, and notes skipped steps", () => {
    wizard = { ...wizard, steps: steps({ plan: "done", details: "skipped" }), currentStep: "security" };
    renderIt();
    const list = screen.getByRole("list", { name: "Set-up steps" });
    expect(within(list).getAllByRole("link")).toHaveLength(7);
    expect(within(list).getByRole("link", { name: /Security/ })).toHaveAttribute("aria-current", "step");
    expect(within(list).getByRole("link", { name: /Security/ })).toHaveAttribute("href", "/setup/security");
    expect(within(list).getByRole("link", { name: /Details/ })).toHaveTextContent("(skipped)");
    expect(within(within(list).getByRole("link", { name: /Plan & seats/ })).getByLabelText("Done")).toBeInTheDocument();
    expect(within(within(list).getByRole("link", { name: /Security/ })).queryByLabelText("Done")).toBeNull();
    expect(screen.getByRole("region", { name: "Set-up progress" })).toHaveTextContent("3 of 7 steps done");
  });

  it("says when everything required is done and only the review is left", () => {
    wizard = { completedAt: null, currentStep: "review", canFinish: true, steps: steps({ plan: "done", details: "done", security: "done", team: "done" }) };
    renderIt();
    const card = screen.getByRole("region", { name: "Set-up progress" });
    expect(card).toHaveTextContent("Everything required is in place");
    expect(within(card).getByRole("link", { name: "Continue set-up" })).toHaveAttribute("href", "/setup/review");
  });

  it("clears 'finish later' when you go back in, so the app takes you through the rest", async () => {
    deferSetup();
    expect(setupDeferred()).toBe(true);
    renderIt();
    await userEvent.click(screen.getByRole("link", { name: "Continue set-up" }));
    expect(setupDeferred()).toBe(false);
  });

  it("is gone once the set-up is finished", () => {
    wizard = { ...wizard, completedAt: "2026-11-07T10:00:00Z" };
    renderIt();
    expect(screen.queryByRole("region", { name: "Set-up progress" })).toBeNull();
    access = { accessState: "open", onboarding: "complete" };
    renderIt();
    expect(screen.queryByRole("region", { name: "Set-up progress" })).toBeNull();
  });

  it("is not shown for organisations that have no set-up wizard", () => {
    access = { accessState: "open", onboarding: "none" };
    renderIt();
    expect(screen.queryByRole("region", { name: "Set-up progress" })).toBeNull();
  });

  it("is only for people who can set the organisation up", () => {
    permissions = ["ncr.read"];
    renderIt();
    expect(screen.queryByRole("region", { name: "Set-up progress" })).toBeNull();
  });
});

describe("the go-live checklist card", () => {
  const items = (done = []) =>
    ["subscription", "site", "departments", "invited", "details", "logo", "security", "joined", "first_ncr"].map((key) => ({
      key,
      required: ["subscription", "site", "departments", "invited"].includes(key),
      done: done.includes(key),
    }));

  beforeEach(() => {
    access = { accessState: "open", onboarding: "complete" };
    checklist = { items: items(["subscription", "site"]), requiredDone: false };
  });

  it("lists the essentials still to do and the recommended extras, each linking to where it is done", () => {
    renderIt();
    const card = screen.getByRole("region", { name: "Go-live checklist" });
    expect(card).toHaveTextContent("2 of 4 essentials still to do");
    const essentials = within(screen.getByRole("list", { name: "Essentials" }));
    expect(essentials.getByRole("link", { name: /add a department/i })).toHaveAttribute("href", "/Settings/Organisation");
    expect(essentials.getByRole("link", { name: /invite someone else/i })).toHaveAttribute("href", "/Settings/Users");
    expect(essentials.getByRole("link", { name: /start your subscription \(done\)/i })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Recommended" })).getAllByRole("link")).toHaveLength(5);
    expect(screen.queryByRole("region", { name: "Set-up progress" })).toBeNull();
  });

  it("goes once every required item is done, even with recommended ones left", () => {
    checklist = { items: items(["subscription", "site", "departments", "invited"]), requiredDone: true };
    renderIt();
    expect(screen.queryByRole("region", { name: "Go-live checklist" })).toBeNull();
  });

  it("is not shown while the wizard is unfinished, nor to people who cannot set the organisation up", () => {
    access = { accessState: "open", onboarding: "in_progress" };
    renderIt();
    expect(screen.queryByRole("region", { name: "Go-live checklist" })).toBeNull();
  });

  it("is not shown to people without organisation.manage", () => {
    permissions = [];
    renderIt();
    expect(screen.queryByRole("region", { name: "Go-live checklist" })).toBeNull();
  });
});
