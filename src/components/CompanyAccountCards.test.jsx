import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let me;
const apiFetch = vi.fn();
vi.mock("../hooks/useQmsApi", () => ({ useMe: () => ({ data: me }) }));
vi.mock("../lib/api-client", () => ({ apiFetch: (...a) => apiFetch(...a), describeApiError: (e) => e.message }));

import CompanyAccountCards from "./CompanyAccountCards";

const renderIt = () => render(<QueryClientProvider client={new QueryClient()}><CompanyAccountCards /></QueryClientProvider>);

beforeEach(() => {
  apiFetch.mockReset();
  me = { sso: { joinable: [], moveCandidates: [] } };
});

describe("with your company account", () => {
  it("shows nothing when there is nothing to join or bring across", () => {
    const { container } = renderIt();
    expect(container).toBeEmptyDOMElement();
  });

  it("joins an organisation that lets people at the domain join", async () => {
    me.sso.joinable = [{ id: "o1", name: "Acme", roleName: "Inspector" }];
    apiFetch.mockResolvedValue({});
    renderIt();
    expect(screen.getByText(/You will start as an inspector/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Join Acme" }));
    expect(apiFetch).toHaveBeenCalledWith("/me/sso-join", { method: "POST", body: { organisationId: "o1" } });
  });

  it("brings the old password account across with its password, and says when it is wrong", async () => {
    me.sso.moveCandidates = [{ id: "o1", name: "Acme" }];
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Bring my account across" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Type the password");
    apiFetch.mockRejectedValueOnce(new Error("That is not the password of your old account"));
    await userEvent.type(screen.getByLabelText(/Your old Fortress password/), "guess");
    await userEvent.click(screen.getByRole("button", { name: "Bring my account across" }));
    expect(await screen.findByText("That is not the password of your old account")).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith("/me/move-to-sso", { method: "POST", body: { organisationId: "o1", password: "guess" } });
  });
});
