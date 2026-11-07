import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
const selectOrganisation = vi.fn();

vi.mock("../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ selectOrganisation }) }));
vi.mock("../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));

import CreateOrganisationForm from "./CreateOrganisationForm";
import { ApiClientError } from "../lib/api-client";

const renderForm = (props = {}) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <CreateOrganisationForm {...props} />
    </QueryClientProvider>
  );

describe("CreateOrganisationForm", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    selectOrganisation.mockReset();
  });

  it("creates the organisation and selects it", async () => {
    apiFetch.mockResolvedValue({ id: "org-new", name: "Acme Ltd" });
    const onCreated = vi.fn();
    renderForm({ onCreated });

    await userEvent.type(screen.getByLabelText("Organisation name"), "Acme Ltd");
    await userEvent.clear(screen.getByLabelText("Site code"));
    await userEvent.type(screen.getByLabelText("Site code"), "lds");
    await userEvent.click(screen.getByRole("button", { name: "Create organisation" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: "org-new", name: "Acme Ltd" }));
    expect(apiFetch).toHaveBeenCalledWith("/organisations", {
      method: "POST",
      body: { name: "Acme Ltd", site: { name: "Main site", code: "LDS" }, timeZone: expect.any(String) },
      idempotencyKey: expect.any(String),
    });
    expect(selectOrganisation).toHaveBeenCalledWith("org-new");
  });

  it("offers every time zone in a list, sends the one chosen and leaves it out when cleared", async () => {
    apiFetch.mockResolvedValue({ id: "org-new", name: "Acme Ltd" });
    renderForm();
    await userEvent.type(screen.getByLabelText("Organisation name"), "Acme Ltd");
    const zone = screen.getByRole("combobox", { name: "Time zone" });
    await userEvent.click(zone);
    await userEvent.type(zone, "Europe/Paris");
    await userEvent.click(await screen.findByRole("option", { name: "Europe/Paris" }));
    await userEvent.click(screen.getByRole("button", { name: "Create organisation" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch.mock.calls[0][1].body.timeZone).toBe("Europe/Paris");
    apiFetch.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Clear Time zone" }));
    await userEvent.click(screen.getByRole("button", { name: "Create organisation" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch.mock.calls[0][1].body).not.toHaveProperty("timeZone");
  });

  it("reuses the same idempotency key when retrying after an error", async () => {
    apiFetch
      .mockRejectedValueOnce(new ApiClientError({ status: 0, code: "api_unreachable", message: "Unreachable" }))
      .mockResolvedValueOnce({ id: "org-new" });
    renderForm();

    await userEvent.type(screen.getByLabelText("Organisation name"), "Acme Ltd");
    await userEvent.click(screen.getByRole("button", { name: "Create organisation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unreachable");
    await userEvent.click(screen.getByRole("button", { name: "Create organisation" }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch.mock.calls[0][1].idempotencyKey).toBe(apiFetch.mock.calls[1][1].idempotencyKey);
  });

  it("does not submit until a name is entered", () => {
    renderForm();
    expect(screen.getByRole("button", { name: "Create organisation" })).toBeDisabled();
  });
});
