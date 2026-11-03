import { useState, useEffect } from "react";
import { IoClose, IoCloudUpload, IoTrash } from "react-icons/io5";
import supabase from "../supabase-client";
import CTAButton from "./CTAButton";
import { TbCancel } from "react-icons/tb";
import { FiUpload } from "react-icons/fi";

/**
 * Uploads or removes a single image in a (private) storage bucket.
 * The parent decides what to store: it receives the new object path via onUploaded(path),
 * and is told to clear its reference via onRemoved(). Storage policies decide which paths
 * the user may write.
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
}) => {
  const [preview, setPreview] = useState(existingUrl || null);
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setPreview(existingUrl || null);
      setFile(null);
      setLoading(false);
    }
  }, [isOpen, existingUrl]);

  const handleFileChange = (e) => {
    const selected = e.target.files?.[0];
    if (selected) {
      setFile(selected);
      setPreview(URL.createObjectURL(selected));
    }
  };

  const handleClose = () => {
    setPreview(existingUrl || null);
    onClose();
  };

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);

    try {
      const fileExt = (file.name.split(".").pop() || "img").toLowerCase();
      const filePath = `${pathPrefix}${crypto.randomUUID()}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filePath, file);
      if (uploadError) throw uploadError;

      await onUploaded?.(filePath);

      // Replace, don't accumulate: remove the previous image once the new one is saved.
      if (existingPath && existingPath !== filePath) {
        await supabase.storage.from(bucket).remove([existingPath]);
      }

      setLoading(false);
      handleClose();
    } catch (err) {
      console.error(err);
      alert(`Upload failed: ${err.message}`);
      setLoading(false);
    }
  };

  const handleRemove = async () => {
    if (!existingPath) {
      setPreview(null);
      setFile(null);
      return;
    }

    setLoading(true);
    try {
      await onRemoved?.();
      await supabase.storage.from(bucket).remove([existingPath]);
      setPreview(null);
      setFile(null);
    } catch (error) {
      console.error("Error removing image:", error);
      alert("Failed to remove image: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-secondary-bg rounded-2xl w-full max-w-md shadow-lg p-5 pt-3 relative">
        <button
          onClick={handleClose}
          disabled={loading}
          className="absolute top-3 right-3 text-secondary-text hover:bg-border-color rounded-lg p-1 cursor-pointer transition duration-300">
          <IoClose size={22} />
        </button>

        <h2 className="text-lg font-semibold mb-4 text-primary-text">
          {preview ? "Update Image" : "Upload Image"}
        </h2>

        {preview ? (
          <div className="relative">
            <img
              src={preview}
              alt="Preview"
              className="rounded-xl w-full h-64 object-cover border"
            />
            <button
              onClick={handleRemove}
              disabled={loading}
              className="absolute top-2 right-2 bg-tertiary-bg/80 p-2 rounded-lg cursor-pointer hover:bg-tertiary-bg transition">
              <IoTrash className="text-red-500" size={20} />
            </button>
          </div>
        ) : (
          <label className="flex flex-col items-center justify-center border-2 border-dashed border-border-color rounded-xl h-64 cursor-pointer hover:bg-tertiary-bg transition">
            <IoCloudUpload size={40} className="text-gray-400 mb-2" />
            <p className="text-gray-500 text-sm">Click to upload</p>
            <input
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
          </label>
        )}

        <div className="flex justify-end mt-4 gap-4">
          <CTAButton
            type="cancel"
            callbackFn={handleClose}
            text="Cancel"
            disabled={loading}
            icon={TbCancel}
          />
          <CTAButton
            type="success"
            callbackFn={handleUpload}
            disabled={!file || loading}
            text={loading ? "Uploading..." : "Upload"}
            icon={FiUpload}
          />
        </div>
      </div>
    </div>
  );
};

export default ModalImageUploader;
