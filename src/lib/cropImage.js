/**
 * Draws the cropped square of an image into a `target`×`target` image (never larger than the crop
 * itself, so small pictures are not blown up) and returns it as a WebP (or JPEG) Blob.
 */
export async function cropToBlob(src, crop, { target = 512, quality = 0.9 } = {}) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("The image could not be read"));
    i.src = src;
  });
  const out = Math.round(Math.min(target, crop.size));
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, out, out);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
  if (blob && blob.type === "image/webp") return blob;
  // Browsers without WebP encoding fall back to JPEG.
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be saved"))), "image/jpeg", quality));
}
