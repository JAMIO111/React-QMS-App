import supabase from "../supabase-client";

export const fetchNCKPI = async ({ organisationId, startDate, endDate, ncType }) => {
  const { data, error } = await supabase.rpc("get_nc_kpi_json", {
    p_organisation_id: organisationId,
    start_date: startDate,
    end_date: endDate,
    nc_type: ncType,
  });

  if (error) throw new Error(error.message);
  return data;
};

export const fetchNCDateTrend = async ({
  organisationId,
  startDate,
  endDate,
  overridePeriod,
  ncType,
}) => {
  const { data, error } = await supabase.rpc("get_nc_date_trend", {
    p_organisation_id: organisationId,
    start_date: startDate,
    end_date: endDate,
    override_period: overridePeriod,
    nc_type: ncType,
  });

  if (error) throw new Error(error.message);
  return data;
};

// Get all rows of an organisation from a tenant-owned table
export const fetchAllForOrganisation = async (table, organisationId) => {
  const { data, error } = await supabase
    .from(table)
    .select("*")
    .eq("organisation_id", organisationId);
  if (error) throw new Error(error.message);
  return data;
};

// Get a row by ID
export const fetchById = async (table, id) => {
  const { data, error } = await supabase
    .from(table)
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return data;
};

// Insert a new row
export const insertRow = async (table, row) => {
  const { data, error } = await supabase
    .from(table)
    .insert([row])
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
};

// Update a row
export const updateRow = async (table, id, updates) => {
  const { data, error } = await supabase
    .from(table)
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
};

// Delete a row. Row Level Security silently skips rows the user may not delete, so a
// delete that affected nothing is reported as an error.
export const deleteRow = async (table, id) => {
  const { data, error } = await supabase
    .from(table)
    .delete()
    .eq("id", id)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error("You don't have permission to delete this record.");
  }
};

/**
 * Uploads an NC attachment to the private nc-files bucket under the organisation's folder
 * (storage policies only allow paths that start with an organisation the user belongs to).
 * @returns {Promise<{ path: string }>}
 */
export const uploadFileToSupabase = async (file, bucket, organisationId, id_ref) => {
  const actualFile = file.file ?? file; // unwrap if needed
  const fileName = (actualFile.name || "unnamed_file").replace(/[/\\]/g, "_");
  const filePath = `${organisationId}/ncr/${id_ref}/${crypto.randomUUID()}-${fileName}`;

  const { error } = await supabase.storage
    .from(bucket)
    .upload(filePath, actualFile);

  if (error) throw new Error(`Upload failed: ${error.message}`);

  return {
    path: filePath,
  };
};

/**
 * Saves file metadata to a Supabase table.
 * @param {Object} options
 * @param {File} options.file - The original File object.
 * @param {string} options.path - Path in Supabase Storage.
 * @param {string} tableName - The name of the table to insert metadata into.
 */
export const saveFileMetadata = async (
  { file, path, id_ref, organisationId },
  tableName
) => {
  const { error } = await supabase.from(tableName).insert([
    {
      organisation_id: organisationId,
      name: file.name,
      size: file.size,
      last_modified: new Date(file.lastModified).toISOString(),
      type: file.type,
      path,
      id_ref, // NCR reference (e.g. NCM-25-001)
    },
  ]);

  if (error) throw new Error(`Metadata save failed: ${error.message}`);
};

/**
 * Deletes a file from Supabase Storage and removes its metadata record.
 * @param {string} path - The path to the file in the storage bucket.
 * @param {string} bucket - The name of the storage bucket.
 * @param {string} tableName - The name of the table to delete metadata from.
 */
export const deleteFileFromSupabase = async (path, bucket, tableName) => {
  const { error: storageError } = await supabase.storage
    .from(bucket)
    .remove([path]);

  if (storageError)
    throw new Error(`File delete failed: ${storageError.message}`);

  const { error: dbError } = await supabase
    .from(tableName)
    .delete()
    .eq("path", path);

  if (dbError) throw new Error(`Metadata delete failed: ${dbError.message}`);
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
