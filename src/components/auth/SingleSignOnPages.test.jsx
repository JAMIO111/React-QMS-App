import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const startCompanySignIn = vi.fn();
const apiFetch = vi.fn();

vi.mock("../../lib/sso", async (importOriginal) => ({ ...(await importOriginal()), startCompanySignIn: (...a) => startCompanySignIn(...a) }));
vi.mock("../../supabase-client", () => ({ default: { auth: {} }, initialAuthLinkError: null }));
vi.mock("../../lib/api-client", () => ({ apiFetch: (...a) => apiFetch(...a), describeApiError: (e) => e.message }));

import SsoSignIn from "./SsoSignIn";
import FirstSignIn from "./FirstSignIn";
import { TERMS_VERSION } from "../../lib/terms";

const at = (path, ui) => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);

beforeEach(() => {
  startCompanySignIn.mockReset();
  apiFetch.mockReset();
});

describe("Sign in with your company account", () => {
  it("goes to the company's sign-in for the domain of the email typed", async () => {
    startCompanySignIn.mockResolvedValue(null);
    at("/sso", <SsoSignIn />);
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Type your work email address");
    await userEvent.type(screen.getByLabelText("Work email"), "Ada@Acme.com");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(startCompanySignIn).toHaveBeenCalledWith({ domain: "acme.com" });
  });

  it("says why when the company has no single sign-on", async () => {
    startCompanySignIn.mockResolvedValue("Your company has not set up single sign-on with Fortress.");
    at("/sso", <SsoSignIn />);
    await userEvent.type(screen.getByLabelText("Work email"), "ada@nowhere.com");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("has not set up single sign-on");
    expect(screen.getByRole("link", { name: /email and password instead/ })).toHaveAttribute("href", "/login");
  });

  it("starts at once from a company portal link or Test sign-in", async () => {
    startCompanySignIn.mockResolvedValue(null);
    at("/sso?domain=Acme.com", <SsoSignIn />);
    await waitFor(() => expect(startCompanySignIn).toHaveBeenCalledWith({ domain: "acme.com" }));
    startCompanySignIn.mockClear();
    at("/sso?provider=abc", <SsoSignIn />);
    await waitFor(() => expect(startCompanySignIn).toHaveBeenCalledWith({ providerId: "abc" }));
  });
});

describe("the first company sign-in", () => {
  const renderIt = (profile) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FirstSignIn profile={profile} />
      </QueryClientProvider>,
    );

  it("asks for the terms, and the name only when the company sent none", async () => {
    apiFetch.mockResolvedValue({});
    renderIt({ email: "ada@acme.com", firstName: "Ada", surname: "Lovelace" });
    expect(screen.queryByText("First name")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Accept the terms");
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/me/terms", { method: "POST", body: { version: TERMS_VERSION } }));
    expect(apiFetch).not.toHaveBeenCalledWith("/me", expect.anything());
  });

  it("saves the name typed before the terms", async () => {
    apiFetch.mockResolvedValue({});
    renderIt({ email: "x@acme.com", firstName: null, surname: null });
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Type your first name and surname");
    await userEvent.type(screen.getByLabelText(/First name/), "Grace");
    await userEvent.type(screen.getByLabelText(/Surname/), "Hopper");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch.mock.calls[0]).toEqual(["/me", { method: "PATCH", body: { firstName: "Grace", surname: "Hopper" } }]);
    expect(apiFetch.mock.calls[1][0]).toBe("/me/terms");
  });
});
