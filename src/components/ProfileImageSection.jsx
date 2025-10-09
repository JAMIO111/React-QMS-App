import { useState } from "react";
import ModalImageUploader from "./ModalImageUploader";
import CTAButton from "./CTAButton";

const ProfileImageSection = ({ noImageText = "No Image" }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState(null);

  return (
    <div className="p-4">
      <div className="flex gap-3 flex-col items-center">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt="Profile"
            className="w-32 h-32 rounded-2xl object-cover border"
          />
        ) : (
          <div className="w-32 h-32 rounded-2xl bg-gray-200 flex items-center justify-center text-gray-400">
            <span className="text-4xl font-semibold">{noImageText}</span>
          </div>
        )}
        <CTAButton
          type="main"
          text={imageUrl ? "Change Image" : "Upload Image"}
          callbackFn={() => setIsModalOpen(true)}
        />
      </div>

      <ModalImageUploader
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        bucket="avatars"
        path="profiles/"
        existingUrl={imageUrl}
        onUploadComplete={(url) => setImageUrl(url)}
      />
    </div>
  );
};

export default ProfileImageSection;
