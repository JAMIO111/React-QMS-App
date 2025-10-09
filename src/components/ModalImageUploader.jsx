import { useState, useEffect } from "react";
import { IoClose, IoCloudUpload, IoTrash } from "react-icons/io5";
import supabase from "../supabase-client";
import CTAButton from "./CTAButton";

const ModalImageUploader = ({
  isOpen,
  onClose,
  bucket = "images",
  path = "uploads/",
  existingUrl = null,
  onUploadComplete, // callback with new public URL
}) => {
  const [preview, setPreview] = useState(existingUrl || null);
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);

  // Reset when modal opens
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

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);

    const fileExt = file.name.split(".").pop();
    const fileName = `${crypto.randomUUID()}.${fileExt}`;
    const filePath = `${path}${fileName}`;

    // Upload to Supabase
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(filePath, file, { upsert: true });

    if (uploadError) {
      alert("Upload failed: " + uploadError.message);
      setLoading(false);
      return;
    }

    // Get public URL
    const {
      data: { publicUrl },
    } = supabase.storage.from(bucket).getPublicUrl(filePath);

    // Optionally delete old file
    if (existingUrl && existingUrl !== publicUrl) {
      const oldPath = existingUrl.split(`${bucket}/`)[1];
      await supabase.storage.from(bucket).remove([oldPath]);
    }

    setLoading(false);
    onUploadComplete(publicUrl);
    onClose();
  };

  const handleRemove = async () => {
    if (!existingUrl) {
      setPreview(null);
      setFile(null);
      return;
    }
    setLoading(true);
    const oldPath = existingUrl.split(`${bucket}/`)[1];
    await supabase.storage.from(bucket).remove([oldPath]);
    setLoading(false);
    setPreview(null);
    setFile(null);
    onUploadComplete(null);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-secondary-bg rounded-2xl w-full max-w-md shadow-lg p-5 relative">
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-3 cursor-pointer right-3 text-gray-500 hover:text-gray-700">
          <IoClose size={22} />
        </button>

        <h2 className="text-lg font-semibold text-primary-text mb-4">
          Upload Image
        </h2>

        {/* Preview */}
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
              className="absolute top-2 cursor-pointer right-2 bg-white/80 p-2 rounded-full hover:bg-white">
              <IoTrash className="text-red-500" size={20} />
            </button>
          </div>
        ) : (
          <label className="flex flex-col items-center justify-center border-2 border-dashed border-border-color rounded-xl h-64 cursor-pointer hover:bg-gray-50">
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

        {/* Buttons */}
        <div className="flex justify-end mt-4 gap-2">
          <CTAButton type="cancel" callbackFn={onClose} text="Cancel" />
          <CTAButton
            type="success"
            callbackFn={handleUpload}
            disabled={!file || loading}
            text={loading ? "Saving..." : "Save"}
          />
        </div>
      </div>
    </div>
  );
};

export default ModalImageUploader;
