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

// Paths asked for in the same moment are signed together in one request (a picker can show dozens of faces at once).
let waiting = null;
const signTogether = (path) => {
  if (!waiting) {
    const batch = { paths: new Set(), promise: null };
    batch.promise = new Promise((resolve) => setTimeout(resolve, 0)).then(async () => {
      waiting = null;
      const paths = [...batch.paths];
      const { data, error } = await supabase.storage.from("avatars").createSignedUrls(paths, EXPIRY_SECONDS);
      if (error) throw new Error(error.message);
      return new Map((data ?? []).filter((d) => !d.error && d.signedUrl).map((d) => [d.path, d.signedUrl]));
    });
    waiting = batch;
  }
  waiting.paths.add(path);
  return waiting.promise.then((urls) => urls.get(path) ?? null);
};

/**
 * Signed URL for someone else's profile picture (anyone who shares an organisation with them may read it), batched with the others shown
 * at the same time. Null while loading, without a path, or when it cannot be read — the caller shows initials instead.
 */
export const useAvatarUrl = (avatarPath) => {
  const { data } = useQuery({
    queryKey: ["signed-url", "avatars", avatarPath],
    queryFn: () => signTogether(avatarPath),
    enabled: !!avatarPath,
    staleTime: (EXPIRY_SECONDS - 60) * 1000,
    retry: false,
  });
  return avatarPath ? data ?? null : null;
};
