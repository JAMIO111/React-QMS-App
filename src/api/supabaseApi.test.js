/* global process */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const apiFetch = vi.fn();
const uploadToSignedUrl = vi.fn();
vi.mock("../lib/api-client", () => ({ apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../supabase-client", () => ({ default: { storage: { from: () => ({ uploadToSignedUrl: (...a) => uploadToSignedUrl(...a) }) } } }));

const { generateSignedUrl, removeOrganisationFile, uploadFileToSupabase, uploadPortalScarFile } = await import("./supabaseApi");

describe("organisation files go through the API (security plan SE3)", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    uploadToSignedUrl.mockReset();
  });

  it("uploads with a token the API signed for that exact path", async () => {
    apiFetch.mockResolvedValue({ token: "tok" });
    uploadToSignedUrl.mockResolvedValue({ error: null });
    const file = new File(["x"], "a/b..pdf", { type: "application/pdf" });
    const { path } = await uploadFileToSupabase(file, "nc-files", "org-1", "n1", "ncr");
    expect(path).toMatch(/^org-1\/ncr\/n1\/[0-9a-f-]+-a_b\.pdf$/);
    expect(apiFetch).toHaveBeenCalledWith("/files/upload-url", { method: "POST", organisationId: "org-1", body: { bucket: "nc-files", path } });
    expect(uploadToSignedUrl).toHaveBeenCalledWith(path, "tok", file, { contentType: "application/pdf" });
  });

  it("a supplier's evidence file: the API chooses the path, then the file is recorded as waiting", async () => {
    apiFetch.mockResolvedValueOnce({ bucket: "scar-files", path: "org-1/scar/c1/u-a.pdf", token: "tok" }).mockResolvedValueOnce({ id: "c1", scar: {} });
    uploadToSignedUrl.mockResolvedValue({ error: null });
    const file = new File(["xx"], "a.pdf", { type: "application/pdf" });
    await uploadPortalScarFile(file, "org-1", "c1");
    expect(apiFetch).toHaveBeenNthCalledWith(1, "/portal/scars/c1/files/upload-url", { method: "POST", organisationId: "org-1", body: { fileName: "a.pdf" } });
    expect(uploadToSignedUrl).toHaveBeenCalledWith("org-1/scar/c1/u-a.pdf", "tok", file, { contentType: "application/pdf" });
    expect(apiFetch).toHaveBeenNthCalledWith(2, "/portal/scars/c1/files", {
      method: "POST", organisationId: "org-1", body: { path: "org-1/scar/c1/u-a.pdf", fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 2 },
    });
  });

  it("refused by the API: nothing is uploaded", async () => {
    apiFetch.mockRejectedValue(new Error("You cannot add a file there"));
    await expect(uploadFileToSupabase(new File(["x"], "a.pdf"), "nc-files", "org-1", "n1")).rejects.toThrow("You cannot add a file there");
    expect(uploadToSignedUrl).not.toHaveBeenCalled();
  });

  it("asks the API for a download link in the file's own organisation, and answers null when it cannot be opened", async () => {
    apiFetch.mockResolvedValueOnce({ url: "https://s/x" });
    expect(await generateSignedUrl("nc-files", "org-2/ncr/n1/x.pdf", 99999)).toBe("https://s/x");
    expect(apiFetch).toHaveBeenCalledWith("/files/download-url", { method: "POST", organisationId: "org-2", body: { bucket: "nc-files", path: "org-2/ncr/n1/x.pdf", expiresIn: 3600 } });
    apiFetch.mockRejectedValueOnce(new Error("network_not_allowed"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await generateSignedUrl("nc-files", "org-2/ncr/n1/x.pdf")).toBeNull();
  });

  it("removes a logo through the API", async () => {
    apiFetch.mockResolvedValue({ removed: true });
    await removeOrganisationFile("org-logos", "org-1/logo/a.png");
    expect(apiFetch).toHaveBeenCalledWith("/files/remove", { method: "POST", organisationId: "org-1", body: { bucket: "org-logos", path: "org-1/logo/a.png" } });
  });

  it("no other code reads or writes Supabase Storage directly (only this helper and the person's own avatar)", () => {
    const allowed = ["src/api/supabaseApi.js", "src/components/ModalImageUploader.jsx", "src/hooks/useSignedAvatarURL.jsx"];
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(js|jsx)$/.test(name) && !/\.test\./.test(name)) files.push(full);
      }
    };
    walk(join(process.cwd(), "src"));
    const offenders = files
      .map((f) => f.slice(process.cwd().length + 1).replaceAll("\\", "/"))
      .filter((f) => !allowed.includes(f) && /\.storage\s*\.\s*from\(|\.storage\.from/.test(readFileSync(join(process.cwd(), f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
