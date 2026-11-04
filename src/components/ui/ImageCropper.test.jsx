import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ImageCropper from "./ImageCropper";

/** jsdom does not load images: give the <img> a size and fire its load event. */
const load = (w, h) => {
  const img = document.querySelector("img");
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true });
  fireEvent.load(img);
};

describe("ImageCropper", () => {
  it("starts centred with the shorter side filling the square", () => {
    const onCropChange = vi.fn();
    render(<ImageCropper src="blob:x" size={200} onCropChange={onCropChange} />);
    load(1000, 500);
    expect(onCropChange).toHaveBeenLastCalledWith({ x: 250, y: 0, size: 500 });
  });

  it("zooms around the centre and keeps the image covering the square", () => {
    const onCropChange = vi.fn();
    render(<ImageCropper src="blob:x" size={200} onCropChange={onCropChange} />);
    load(1000, 500);
    fireEvent.change(screen.getByRole("slider", { name: "Zoom" }), { target: { value: "2" } });
    expect(onCropChange).toHaveBeenLastCalledWith({ x: 375, y: 125, size: 250 });
    // Moving left as far as possible stops at the image's left edge.
    const area = screen.getByRole("application");
    for (let i = 0; i < 50; i++) fireEvent.keyDown(area, { key: "ArrowLeft", shiftKey: true });
    expect(onCropChange.mock.lastCall[0]).toEqual({ x: 0, y: 125, size: 250 });
    // Zooming back out cannot uncover the square.
    fireEvent.change(screen.getByRole("slider", { name: "Zoom" }), { target: { value: "1" } });
    const last = onCropChange.mock.lastCall[0];
    expect(last.size).toBe(500);
    expect(last.x).toBeGreaterThanOrEqual(0);
    expect(last.x + last.size).toBeLessThanOrEqual(1000);
    expect(last.y).toBe(0);
  });

  it("drags the image", () => {
    const onCropChange = vi.fn();
    render(<ImageCropper src="blob:x" size={200} onCropChange={onCropChange} />);
    load(400, 400); // scale 0.5
    fireEvent.change(screen.getByRole("slider", { name: "Zoom" }), { target: { value: "2" } }); // crop 200 at (100, 100)
    const area = screen.getByRole("application");
    // jsdom's PointerEvent has no coordinates; a MouseEvent of the same type carries them.
    const pointer = (type, x, y) => fireEvent(area, new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    pointer("pointerdown", 100, 100);
    pointer("pointermove", 150, 100); // 50 screen px = 50 image px at scale 1
    pointer("pointerup", 150, 100);
    expect(onCropChange).toHaveBeenLastCalledWith({ x: 50, y: 100, size: 200 });
  });
});
