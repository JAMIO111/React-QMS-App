import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const upload = vi.fn();
const remove = vi.fn();
vi.mock("../supabase-client", () => ({ default: { storage: { from: () => ({ upload: (...a) => upload(...a), remove: (...a) => remove(...a) }) } } }));
// Canvas and image loading are not available in jsdom: stand in for the cropper.
vi.mock("./ui/ImageCropper", async () => {
  const { useEffect } = await import("react");
  const CropperStub = ({ onCropChange }) => {
    useEffect(() => onCropChange({ x: 10, y: 0, size: 900 }), [onCropChange]);
    return <div data-testid="cropper" />;
  };
  return { default: CropperStub };
});
vi.mock("../lib/cropImage", () => ({ cropToBlob: vi.fn(async () => new Blob(["x"], { type: "image/webp" })) }));

import ModalImageUploader from "./ModalImageUploader";
import { cropToBlob } from "../lib/cropImage";

const file = (name, type, size = 10) => new File([new Uint8Array(size)], name, { type });

beforeEach(() => {
  upload.mockReset().mockResolvedValue({ error: null });
  remove.mockReset().mockResolvedValue({ error: null });
  globalThis.URL.createObjectURL = vi.fn(() => "blob:picked");
  globalThis.URL.revokeObjectURL = vi.fn();
});

const open = (props = {}) => {
  const onUploaded = vi.fn();
  const onRemoved = vi.fn();
  const onClose = vi.fn();
  render(<ModalImageUploader isOpen bucket="avatars" pathPrefix="users/u1/" onUploaded={onUploaded} onRemoved={onRemoved} onClose={onClose} {...props} />);
  return { onUploaded, onRemoved, onClose };
};

describe("ModalImageUploader", () => {
  it("crops a chosen picture to a square and uploads it small", async () => {
    const { onUploaded, onClose } = open({ existingPath: "users/u1/old.png", existingUrl: "https://x/old.png" });
    expect(screen.getByRole("dialog", { name: "Profile picture" })).toBeInTheDocument();
    expect(screen.getByAltText("Current picture")).toHaveClass("aspect-square");
    await userEvent.upload(screen.getByTestId("image-input"), file("holiday.jpg", "image/jpeg", 8_000_000));
    expect(screen.getByTestId("cropper")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUploaded).toHaveBeenCalled());
    expect(cropToBlob).toHaveBeenCalledWith("blob:picked", { x: 10, y: 0, size: 900 });
    const [path, blob, options] = upload.mock.calls[0];
    expect(path).toMatch(/^users\/u1\/[0-9a-f-]+\.webp$/);
    expect(blob.type).toBe("image/webp");
    expect(options).toEqual({ contentType: "image/webp" });
    expect(onUploaded).toHaveBeenCalledWith(path);
    expect(remove).toHaveBeenCalledWith(["users/u1/old.png"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("refuses files that are not pictures", async () => {
    open();
    await userEvent.upload(screen.getByTestId("image-input"), file("notes.pdf", "application/pdf"), { applyAccept: false });
    expect(screen.getByRole("alert")).toHaveTextContent("Choose an image file");
    expect(screen.queryByTestId("cropper")).not.toBeInTheDocument();
  });

  it("shows why an upload failed and stays open", async () => {
    upload.mockResolvedValue({ error: new Error("The object exceeded the maximum allowed size") });
    const { onClose } = open();
    await userEvent.upload(screen.getByTestId("image-input"), file("me.png", "image/png"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not saved: The object exceeded the maximum allowed size");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("removes the current picture", async () => {
    const { onRemoved, onClose } = open({ existingPath: "users/u1/old.png", existingUrl: "https://x/old.png" });
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onRemoved).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(["users/u1/old.png"]);
  });
});
