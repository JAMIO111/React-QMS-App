import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const startCompanySignIn = vi.fn();
const signOut = vi.fn();
vi.mock("../lib/sso", () => ({ startCompanySignIn: (...a) => startCompanySignIn(...a) }));
vi.mock("../hooks/useSignOut", () => ({ default: () => [signOut, false] }));

import SsoRequired from "./SsoRequired";

const acme = { id: "o1", name: "Acme", providerId: "aaaaaaaa-0000-4000-8000-000000000001", breakGlass: false };
const renderIt = (organisations) => render(<MemoryRouter><SsoRequired organisations={organisations} /></MemoryRouter>);

beforeEach(() => {
  startCompanySignIn.mockReset();
  signOut.mockReset();
});

describe("the company sign-in is required", () => {
  it("names the organisation and starts its company sign-in", async () => {
    startCompanySignIn.mockResolvedValue(null);
    renderIt([acme]);
    expect(screen.getByRole("heading", { name: "Acme requires your company sign-in" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign in with your company account" }));
    expect(startCompanySignIn).toHaveBeenCalledWith({ providerId: acme.providerId });
    expect(screen.queryByRole("link", { name: "Use two-factor instead" })).toBeNull();
  });

  it("shows why the company sign-in could not start", async () => {
    startCompanySignIn.mockResolvedValue("Your company has not set up single sign-on with Fortress.");
    renderIt([acme]);
    await userEvent.click(screen.getByRole("button", { name: "Sign in with your company account" }));
    expect(await screen.findByText("Your company has not set up single sign-on with Fortress.")).toBeInTheDocument();
  });

  it("offers a break-glass member two-factor instead, and anyone a way to sign out", async () => {
    renderIt([{ ...acme, breakGlass: true }]);
    expect(screen.getByRole("link", { name: "Use two-factor instead" })).toHaveAttribute("href", "/mfa?next=%2F");
    expect(screen.getByText(/You are a break-glass member/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalled();
  });

  it("says so when the company sign-in is not connected", () => {
    renderIt([{ ...acme, providerId: null }]);
    expect(screen.getByText(/company sign-in is not connected/)).toBeInTheDocument();
  });
});
