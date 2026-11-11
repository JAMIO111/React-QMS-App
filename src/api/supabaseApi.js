import supabase from "../supabase-client";

// Files only: everything else goes through the API (src/lib/api-client.js), never straight to the tables.

/**
 * Uploads an NC attachment to the private nc-files bucket under the organisation's folder
 * (storage policies only allow paths that start with an organisation the user belongs to).
 * @returns {Promise<{ path: string }>}
 */
export const uploadFileToSupabase = async (file, bucket, organisationId, id_ref, folder = "ncr") => {
  const actualFile = file.file ?? file; // unwrap if needed
  const fileName = (actualFile.name || "unnamed_file").replace(/[/\\]/g, "_").replace(/\.{2,}/g, ".");
  const filePath = `${organisationId}/${folder}/${id_ref}/${crypto.randomUUID()}-${fileName}`;

  const { error } = await supabase.storage
    .from(bucket)
    .upload(filePath, actualFile);

  if (error) throw new Error(`Upload failed: ${error.message}`);

  return {
    path: filePath,
  };
};

/**
 * Generates a signed URL for a file in Supabase Storage.
 * @param {string} bucket - The storage bucket name.
 * @param {string} filePath - The path/key of the file in the bucket.
 * @param {number} expiresIn - Expiration time in seconds (default 10 minutes).
 * @returns {string|null} - Returns the signed URL or null if error.
 */
export const generateSignedUrl = async (
  bucket,
  filePath,
  expiresIn = 60 * 10
) => {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(filePath, expiresIn);

  if (error) {
    console.error("Error generating signed URL:", error.message);
    return null;
  }

  return data.signedUrl;
};
