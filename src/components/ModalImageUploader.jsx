import { useEffect, useRef, useState } from "react";
import { CloudUploadIcon, ImageIcon, SaveIcon, Trash2Icon } from "@/components/icons";
import supabase from "../supabase-client";
import Dialog from "./ui/Dialog";
import ImageCropper from "./ui/ImageCropper";
import { cropToBlob } from "../lib/cropImage";

/** Pictures bigger than this are refused before cropping (they are shrunk to 512 px anyway). */
const MAX_SOURCE_MB = 25;
const btn = {
  neutral: "flex items-center gap-2 rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-neutral-btn-bg-hover disabled:opacity-50 cursor-pointer",
  save: "flex items-center gap-2 rounded-lg border border-success-btn-border bg-success-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-success-btn-bg-hover disabled:opacity-50 cursor-pointer",
  danger: "flex items-center gap-2 rounded-lg border border-error-btn-border bg-error-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-error-btn-bg-hover disabled:opacity-50 cursor-pointer",
};

/**
 * Uploads, replaces or removes a single square image in a (private) storage bucket. A chosen
 * picture is cropped to a square in the browser and saved as a 512 × 512 WebP, so large photos
 * from a phone or camera fit the bucket's size limit. The parent gets the new object path via
 * onUploaded(path) and is told to clear its reference via onRemoved().
 */
const ModalImageUploader = ({
  isOpen,
  onClose,
  bucket,
  pathPrefix, // e.g. "users/<user_id>/"
  existingPath = null,
  existingUrl = null, // signed URL of the existing image, for preview
  onUploaded,
  onRemoved,
  title = "Profile picture",
  round = false,
}) => {
  const [source, setSource] = useState(null); // object URL of the chosen picture
  const [crop, setCrop] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    setSource(null);
    setCrop(null);
    setBusy(false);
    setProblem(null);
    return undefined;
  }, [isOpen]);
  useEffect(() => () => source && URL.revokeObjectURL(source), [source]);

  const choose = (file) => {
    setProblem(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) return setProblem("Choose an image file (JPG, PNG, WebP, HEIC…).");
    if (file.size > MAX_SOURCE_MB * 1024 * 1024) return setProblem(`That picture is over ${MAX_SOURCE_MB} MB. Choose a smaller one.`);
    setSource(URL.createObjectURL(file));
  };

  const save = async () => {
    if (!source || !crop) return;
    setBusy(true);
    setProblem(null);
    try {
      const blob = await cropToBlob(source, crop);
      const ext = blob.type === "image/webp" ? "webp" : "jpg";
      const filePath = `${pathPrefix}${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from(bucket).upload(filePath, blob, { contentType: blob.type });
      if (error) throw error;
      await onUploaded?.(filePath);
      // Replace, don't accumulate: remove the previous image once the new one is saved.
      if (existingPath && existingPath !== filePath) await supabase.storage.from(bucket).remove([existingPath]);
      onClose();
    } catch (err) {
      setProblem(`Not saved: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await onRemoved?.();
      if (existingPath) await supabase.storage.from(bucket).remove([existingPath]);
      onClose();
    } catch (err) {
      setProblem(`Not removed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!isOpen) return null;

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      hidden
      data-testid="image-input"
      onChange={(e) => {
        choose(e.target.files?.[0]);
        e.target.value = "";
      }}
    />
  );

  return (
    <Dialog title={title} onClose={() => !busy && onClose()} width="max-w-sm">
      <div className="flex flex-col items-center gap-4">
        {source ? (
          <>
            <ImageCropper src={source} onCropChange={setCrop} round={round} />
            <p className="text-center text-xs text-secondary-text">Drag to position, zoom to fit. Saved as a 512 × 512 square.</p>
          </>
        ) : existingUrl ? (
          <img src={existingUrl} alt="Current picture" className={`aspect-square w-72 border border-border-color object-cover ${round ? "rounded-full" : "rounded-xl"}`} />
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              choose(e.dataTransfer.files?.[0]);
            }}
            className={`flex aspect-square w-72 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-secondary-text transition-colors cursor-pointer ${
              dragging ? "border-brand-primary bg-brand-primary/10" : "border-border-dark-color hover:bg-primary-text/5"
            }`}>
            <CloudUploadIcon className="h-10 w-10" />
            <span className="text-sm text-primary-text">Drop a picture here or click to choose</span>
            <span className="text-xs">You can crop it next</span>
          </button>
        )}
        {fileInput}

        {problem && (
          <p role="alert" className="w-full text-sm text-error-color">
            {problem}
          </p>
        )}

        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            {(source || existingUrl) && (
              <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} className={btn.neutral}>
                <ImageIcon className="h-4 w-4" /> {source ? "Choose another" : "Replace"}
              </button>
            )}
            {!source && existingPath && (
              <button type="button" onClick={remove} disabled={busy} className={btn.danger}>
                <Trash2Icon className="h-4 w-4" /> Remove
              </button>
            )}
          </div>
          {source && (
            <button type="button" onClick={save} disabled={busy || !crop} className={btn.save}>
              <SaveIcon className="h-4 w-4" /> {busy ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
};

export default ModalImageUploader;
