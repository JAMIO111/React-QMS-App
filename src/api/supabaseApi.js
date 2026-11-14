import supabase from "../supabase-client";
import { apiFetch } from "../lib/api-client";

// Organisation files: the API checks the person, the file's own rule and the organisation's network policy, then signs a short-lived link
// (docs/security-plan.md SE3). The browser never reads or writes an organisation bucket directly, so an organisation that enforces its approved
// networks also controls its files. Avatars (the person's own pictures) are the one exception and stay in their own hooks.

const organisationOf = (path) => (typeof path === "string" ? path.split("/")[0] : undefined);

/** Uploads a file to an exact path in an organisation bucket (the API refuses a path the person may not add to). */
export const uploadToPath = async (file, bucket, organisationId, path, contentType) => {
  const { token } = await apiFetch("/files/upload-url", { method: "POST", organisationId, body: { bucket, path } });
  const { error } = await supabase.storage.from(bucket).uploadToSignedUrl(path, token, file, contentType ? { contentType } : undefined);
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return { path };
};

/**
 * Uploads a record's file to `<organisation>/<folder>/<record id>/<uuid>-<name>` in a private bucket.
 * @returns {Promise<{ path: string }>}
 */
export const uploadFileToSupabase = async (file, bucket, organisationId, id_ref, folder = "ncr") => {
  const actualFile = file.file ?? file; // unwrap if needed
  const fileName = (actualFile.name || "unnamed_file").replace(/[/\\]/g, "_").replace(/\.{2,}/g, ".");
  const filePath = `${organisationId}/${folder}/${id_ref}/${crypto.randomUUID()}-${fileName}`;
  return uploadToPath(actualFile, bucket, organisationId, filePath, actualFile.type || undefined);
};

/**
 * A short-lived link to a file in an organisation bucket, or null when it cannot be opened. The organisation is the first part of the path.
 * @param {string} bucket
 * @param {string} filePath
 * @param {number} expiresIn seconds (30 to 3600; the server shortens it while network restrictions are enforced)
 */
export const generateSignedUrl = async (bucket, filePath, expiresIn = 60 * 10) => {
  try {
    const { url } = await apiFetch("/files/download-url", {
      method: "POST",
      organisationId: organisationOf(filePath),
      body: { bucket, path: filePath, expiresIn: Math.min(3600, Math.max(30, Math.round(expiresIn))) },
    });
    return url;
  } catch (error) {
    console.error("Error generating signed URL:", error.message);
    return null;
  }
};

/** Removes a replaced or cleared organisation logo file (organisation.manage). */
export const removeOrganisationFile = async (bucket, path) => {
  if (!path) return;
  await apiFetch("/files/remove", { method: "POST", organisationId: organisationOf(path), body: { bucket, path } });
};
