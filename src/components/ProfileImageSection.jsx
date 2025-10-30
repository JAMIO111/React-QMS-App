import { useState, useEffect } from "react";
import ModalImageUploader from "./ModalImageUploader";
import CTAButton from "./CTAButton";

const ProfileImageSection = ({
  item,
  bucket = "avatars",
  path = "owners",
  table = "Owners",
  noImageText = "No Image",
  onImageChange, // optional callback to parent for DB update or state sync
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState(null);

  // Sync local image state when item changes
  useEffect(() => {
    setImageUrl(item?.avatar || null);
  }, [item]);

  const handleUploadComplete = (url) => {
    setImageUrl(url);
    if (onImageChange) onImageChange(url);
  };

  return (
    <div className="p-4">
      <div className="flex gap-3 flex-col items-center">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={`${item?.id || "User"} profile`}
            className="w-32 h-32 rounded-2xl object-cover border"
          />
        ) : (
          <div className="w-32 h-32 rounded-2xl bg-tertiary-bg shadow-s flex items-center justify-center text-gray-400">
            <span className="text-2xl text-center">{noImageText}</span>
          </div>
        )}

        <CTAButton
          type="main"
          text={imageUrl ? "Change Image" : "Upload Image"}
          callbackFn={() => setIsModalOpen(true)}
        />
      </div>

      {/* Image Upload Modal */}
      <ModalImageUploader
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        bucket={bucket}
        path={`${path}/${item?.id}/`} // store neatly under user folder
        table={table}
        userId={item?.id}
        existingUrl={item?.avatar || null}
        onUploadComplete={handleUploadComplete}
      />
    </div>
  );
};

export default ProfileImageSection;
