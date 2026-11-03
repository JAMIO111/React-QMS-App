import { useState } from "react";
import ModalImageUploader from "./ModalImageUploader";
import { IoAdd } from "react-icons/io5";
import { MdOutlineEdit } from "react-icons/md";
import supabase from "../supabase-client";
import useSignedAvatarUrl from "../hooks/useSignedAvatarURL";

/**
 * The signed-in user's profile picture. Stored in the private `avatars` bucket at
 * users/<user_id>/<file>, referenced by profiles.avatar_path, shown via a signed URL.
 */
const ProfileImageSection = ({
  profile,
  noImageText = "No Image",
  onChange,
  width,
  height,
  aspectRatio = "aspect-square",
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { signedUrl } = useSignedAvatarUrl(profile?.avatar_path);

  const saveAvatarPath = async (path) => {
    const { error } = await supabase
      .from("profiles")
      .update({ avatar_path: path })
      .eq("id", profile.id);
    if (error) throw error;
    onChange?.(path);
  };

  return (
    <div className="flex flex-col items-center justify-center">
      <div
        className={`${width} ${height} ${aspectRatio} group relative flex gap-3 flex-col items-center`}>
        <button
          type="button"
          onClick={() => setIsModalOpen(true)}
          aria-label={signedUrl ? "Change profile picture" : "Add profile picture"}
          className="absolute opacity-0 group-hover:opacity-100 focus:opacity-100 cursor-pointer transition-opacity duration-300 bottom-2 right-2 rounded-full bg-primary-bg/80">
          {signedUrl ? (
            <MdOutlineEdit className="h-6 w-6 text-primary-text m-2" />
          ) : (
            <IoAdd className="h-7 w-7 text-primary-text m-1" />
          )}
        </button>
        {signedUrl ? (
          <img
            src={signedUrl}
            alt="Profile"
            className="w-full h-full rounded-2xl object-cover border"
          />
        ) : (
          <div className="w-full h-full rounded-2xl bg-tertiary-bg shadow-s flex items-center justify-center text-gray-400">
            <span className="text-lg text-center">{noImageText}</span>
          </div>
        )}
      </div>

      {profile?.id && (
        <ModalImageUploader
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          bucket="avatars"
          pathPrefix={`users/${profile.id}/`}
          existingPath={profile.avatar_path}
          existingUrl={signedUrl}
          onUploaded={saveAvatarPath}
          onRemoved={() => saveAvatarPath(null)}
        />
      )}
    </div>
  );
};

export default ProfileImageSection;
