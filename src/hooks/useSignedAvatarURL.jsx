import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";

const EXPIRY_SECONDS = 60 * 30;

/**
 * Short-lived signed URL for a file in the private avatars bucket (path `users/<user_id>/...`).
 * Returns null while loading, when there is no path, or when the user may not see it.
 */
const useSignedAvatarUrl = (avatarPath, bucket = "avatars") => {
  const { data, isLoading, error } = useQuery({
    queryKey: ["signed-url", bucket, avatarPath],
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(avatarPath, EXPIRY_SECONDS);
      if (error) throw new Error(error.message);
      return data.signedUrl;
    },
    enabled: !!avatarPath,
    staleTime: (EXPIRY_SECONDS - 60) * 1000, // refresh before the URL expires
    retry: false,
  });

  return { signedUrl: avatarPath ? data ?? null : null, loading: isLoading, error };
};

export default useSignedAvatarUrl;
