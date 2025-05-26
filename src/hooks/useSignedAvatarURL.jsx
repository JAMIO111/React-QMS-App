import { useEffect, useState } from "react";
import supabase from "../supabase-client";

const useSignedAvatarUrl = (
  avatarPath,
  bucket = "avatars",
  expirySeconds = 3600 * 8
) => {
  const [signedUrl, setSignedUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchSignedUrl = async () => {
      if (!avatarPath) return;

      setLoading(true);
      setError(null);

      console.log("Generating signed URL for avatar path:", avatarPath);
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(avatarPath, expirySeconds);

      if (error) {
        console.error("Error fetching signed URL:", error);
        setError(error);
        setSignedUrl(null);
      } else {
        console.log("Fetched signed URL:", data);
        setSignedUrl(data.signedUrl);
      }

      setLoading(false);
    };

    fetchSignedUrl();
  }, [avatarPath, bucket, expirySeconds]);

  return { signedUrl, loading, error };
};

export default useSignedAvatarUrl;
