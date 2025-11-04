import { useState, useEffect } from "react";
import { IoClose, IoCloudUpload, IoTrash } from "react-icons/io5";
import supabase from "../supabase-client";
import CTAButton from "./CTAButton";
import { TbCancel } from "react-icons/tb";
import { FiUpload } from "react-icons/fi";

const ModalImageUploader = ({
  isOpen,
  onClose,
  bucket = "images",
  path = "uploads/",
  table, // e.g., "Owners"
  userId, // UUID or PK
  existingUrl = null,
  onUploadComplete,
}) => {
  const [preview, setPreview] = useState(existingUrl || null);
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // If existingUrl is null (after delete), clear preview
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
      const fileExt = file.name.split(".").pop();
      const fileName = `${crypto.randomUUID()}.${fileExt}`;
      const filePath = `${path}${fileName}`;

      // Upload to Supabase Storage
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      // Get public URL
      const {
        data: { publicUrl },
      } = supabase.storage.from(bucket).getPublicUrl(filePath);

      // Update DB record if applicable
      if (table && userId) {
        const { error: updateError } = await supabase
          .from(table)
          .update({ avatar: publicUrl })
          .eq("id", userId);

        if (updateError) throw updateError;
      }

      setLoading(false);
      onUploadComplete(publicUrl);
      handleClose();
    } catch (err) {
      console.error(err);
      alert(`Upload failed: ${err.message}`);
      setLoading(false);
    }
  };

  const handleRemove = async () => {
    if (!preview) return;

    setLoading(true);

    try {
      // Delete file from storage
      const oldPath = preview.split(`${bucket}/`)[1];
      await supabase.storage.from(bucket).remove([oldPath]);

      // Update table/avatar field
      if (table && userId) {
        await supabase.from(table).update({ avatar: null }).eq("id", userId);
      }

      // Clear local state
      setPreview(null);
      setFile(null);

      // Notify parent AFTER closing
      if (onUploadComplete) onUploadComplete(null);
    } catch (error) {
      console.error("Error removing avatar:", error);
      alert("Failed to remove avatar: " + error.message);
    } finally {
      setPreview(existingUrl || null);
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
