import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let profile;
const apiFetch = vi.fn();
const signOut = vi.fn();
vi.mock("../../hooks/useQmsApi", () => ({ useMe: () => ({ data: { profile }, isLoading: false }) }));
vi.mock("../../hooks/useSignOut", () => ({ default: () => [signOut, false] }));
vi.mock("../../lib/api-client", () => ({ apiFetch: (...a) => apiFetch(...a), describeApiError: (e) => e.message }));

import MemberWelcome from "./MemberWelcome";
import SeatWaiting from "./SeatWaiting";
import { firstOpenStep, managersWords, nextReminderAt, waitingFor } from "../../lib/memberOnboarding";

const welcome = (over = {}) => ({ id: "o1", name: "Acme Ltd", aboutDone: false, notificationsDone: false, waitingForSeat: false, ...over });
const wait = (over = {}) => ({ id: "o1", name: "Acme Ltd", managers: ["Olga Owner", "Sam Admin"], lastToldAt: null, ...over });
const renderIt = (ui) => render(<QueryClientProvider client={new QueryClient()}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);

beforeEach(() => {
  profile = { firstName: "Nina", surname: "", jobTitle: null };
  apiFetch.mockReset().mockResolvedValue({});
  signOut.mockReset();
});

describe("member onboarding (seats plan SM6)", () => {
  it("is the member's own set-up: about you first, with what we already know", async () => {
    renderIt(<MemberWelcome welcome={welcome()} />);
    expect(screen.getByRole("heading", { name: "Welcome to Acme Ltd" })).toBeInTheDocument();
    expect(screen.getByText(/Your organisation is already set up/)).toBeInTheDocument();
    expect(screen.getByLabelText(/First name/)).toHaveValue("Nina");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Type your first name and surname.");
    expect(apiFetch).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText(/Surname/), "New");
    await userEvent.type(screen.getByLabelText(/Job title/), "Inspector");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(apiFetch).toHaveBeenCalledWith("/me", { method: "PATCH", body: { firstName: "Nina", surname: "New", jobTitle: "Inspector" } });
    expect(apiFetch).toHaveBeenCalledWith("/me/welcome", { method: "POST", body: { organisationId: "o1", step: "about" } });
    expect(await screen.findByRole("region", { name: "How we reach you" })).toBeInTheDocument();
  });

  it("picks up where they left off, and ends ready to go when they have a seat", async () => {
    renderIt(<MemberWelcome welcome={welcome({ aboutDone: true, notificationsDone: true })} />);
    await userEvent.click(screen.getByRole("button", { name: "Go to Fortress" }));
    expect(apiFetch).toHaveBeenCalledWith("/me/welcome", { method: "POST", body: { organisationId: "o1", step: "done" } });
  });

  it("ends on the waiting screen without a seat", () => {
    renderIt(<MemberWelcome welcome={welcome({ aboutDone: true, notificationsDone: true })} wait={wait()} />);
    expect(screen.getByRole("heading", { name: "You need a seat in Acme Ltd" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to Fortress" })).toBeNull();
  });
});

describe("waiting for a seat (seats plan SM4)", () => {
  it("says who can give a seat and lets the person remind them", async () => {
    renderIt(<SeatWaiting wait={wait()} />);
    expect(screen.getByText(/Olga Owner or Sam Admin can give you one/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("They have not been told yet.");
    await userEvent.click(screen.getByRole("button", { name: "Remind them" }));
    expect(apiFetch).toHaveBeenCalledWith("/me/seat-reminder", { method: "POST", body: { organisationId: "o1" } });
    expect(await screen.findByText("We have reminded them.")).toBeInTheDocument();
  });

  it("does not offer a reminder within a day of the last one", () => {
    renderIt(<SeatWaiting wait={wait({ lastToldAt: new Date(Date.now() - 60_000).toISOString() })} />);
    expect(screen.getByRole("button", { name: "Remind them" })).toBeDisabled();
    expect(screen.getByText(/You can remind them again from/)).toBeInTheDocument();
  });

  it("offers signing out", async () => {
    renderIt(<SeatWaiting wait={wait()} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("words and timings", () => {
    expect(managersWords([])).toBeNull();
    expect(managersWords(["A"])).toBe("A");
    expect(managersWords(["A", "B", "C"])).toBe("A, B or C");
    expect(nextReminderAt(null)).toBeNull();
    expect(nextReminderAt(new Date(Date.now() - 2 * 864e5).toISOString())).toBeNull();
    expect(nextReminderAt(new Date().toISOString())).toBeInstanceOf(Date);
    expect(firstOpenStep({ aboutDone: true, notificationsDone: false })).toBe("notifications");
    expect(waitingFor({ seats: { waitingIn: [{ id: "o1" }] } }, "o1")).toEqual({ id: "o1" });
    expect(waitingFor({ seats: { waitingIn: [] } }, "o1")).toBeNull();
  });
});
