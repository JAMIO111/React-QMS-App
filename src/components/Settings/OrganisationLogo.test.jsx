import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mutateAsync = vi.fn();
const upload = vi.fn();
const removeFile = vi.fn();
let logo = { data: null, isLoading: false };
vi.mock("../../hooks/useQmsApi", () => ({
  LOGO_TYPES: { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" },
  LOGO_MAX_BYTES: 1024 * 1024,
  useOrganisationLogo: () => logo,
  useUpdateOrganisation: () => ({ mutateAsync }),
  uploadOrganisationLogo: (...a) => upload(...a),
  removeOrganisationLogoFile: (...a) => removeFile(...a),
}));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1", organisation: { name: "Acme Ltd" } }) }));
const showToast = vi.fn();
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));

import OrganisationLogo from "./OrganisationLogo";

beforeEach(() => {
  mutateAsync.mockReset().mockResolvedValue({});
  upload.mockReset().mockResolvedValue("org-1/logo/new.png");
  removeFile.mockReset().mockResolvedValue();
  showToast.mockReset();
  logo = { data: null, isLoading: false };
});

const png = (size = 2048) => new File([new Uint8Array(size)], "logo.png", { type: "image/png" });

describe("OrganisationLogo", () => {
  it("shows the Fortress QMS mark until a logo is uploaded", () => {
    render(<OrganisationLogo logoPath={null} canManage />);
    expect(screen.getByRole("img", { name: /Fortress QMS mark/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload logo" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("uploads to the organisation's logo folder, saves it and removes the old file", async () => {
    render(<OrganisationLogo logoPath="org-1/logo/old.png" canManage />);
    const file = png();
    await userEvent.upload(screen.getByTestId("logo-input"), file);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ body: { settings: { logoPath: "org-1/logo/new.png" } } }));
    expect(upload).toHaveBeenCalledWith(file, "org-1");
    expect(removeFile).toHaveBeenCalledWith("org-1/logo/old.png");
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Logo updated" }));
  });

  it("refuses files that are too big or the wrong type", async () => {
    render(<OrganisationLogo logoPath={null} canManage />);
    await userEvent.upload(screen.getByTestId("logo-input"), png(2 * 1024 * 1024));
    expect(await screen.findByRole("alert")).toHaveTextContent("1 MB or smaller");
    const gif = new File(["x"], "logo.gif", { type: "image/gif" });
    await userEvent.upload(screen.getByTestId("logo-input"), gif, { applyAccept: false });
    expect(await screen.findByRole("alert")).toHaveTextContent("PNG, JPG, WebP or SVG");
    expect(upload).not.toHaveBeenCalled();
  });

  it("removes the logo", async () => {
    logo = { data: "https://signed/logo.png", isLoading: false };
    render(<OrganisationLogo logoPath="org-1/logo/old.png" canManage />);
    expect(screen.getByRole("img", { name: "Organisation logo" })).toHaveAttribute("src", "https://signed/logo.png");
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ body: { settings: { logoPath: null } } }));
    expect(removeFile).toHaveBeenCalledWith("org-1/logo/old.png");
  });

  it("is read-only without organisation.manage", () => {
    render(<OrganisationLogo logoPath={null} canManage={false} />);
    expect(screen.queryByRole("button", { name: /logo/i })).toBeNull();
    expect(screen.getByText("An administrator can change the logo.")).toBeInTheDocument();
  });
});
