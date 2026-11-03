import { useState, useEffect } from "react";
import ModalImageUploader from "./ModalImageUploader";
import { IoAdd } from "react-icons/io5";
import { MdOutlineEdit } from "react-icons/md";

const ProfileImageSection = ({
  item,
  bucket = "avatars",
  path = "owners",
  table = "Owners",
  noImageText = "No Image",
  onImageChange, // optional callback to parent for DB update or state sync
  width,
  height,
  aspectRatio = "aspect-square",
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
    <div className="flex flex-col items-center justify-center">
      <div
        className={`${width} ${height} ${aspectRatio} group relative flex gap-3 flex-col items-center`}>
        <div
          onClick={() => setIsModalOpen(true)}
          className="absolute opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity duration-300 bottom-2 right-2 rounded-full bg-primary-bg/80">
          {imageUrl ? (
            <MdOutlineEdit className="h-6 w-6 text-primary-text m-2" />
          ) : (
            <IoAdd className="h-7 w-7 text-primary-text m-1" />
          )}
        </div>
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={`${item?.id || "User"} profile`}
            className="w-full h-full rounded-2xl object-cover border"
          />
        ) : (
          <div className="w-full h-full rounded-2xl bg-tertiary-bg shadow-s flex items-center justify-center text-gray-400">
            <span className="text-lg text-center">{noImageText}</span>
          </div>
        )}
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
