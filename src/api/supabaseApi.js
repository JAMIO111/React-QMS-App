import supabase from "../supabase-client";

export const fetchNCKPI = async ({ startDate, endDate, ncType }) => {
  const { data, error } = await supabase.rpc("get_nc_kpi_json", {
    start_date: startDate,
    end_date: endDate,
    nc_type: ncType,
  });

  if (error) throw new Error(error.message);
  return data;
};

export const fetchNCDateTrend = async ({
  startDate,
  endDate,
  overridePeriod,
  ncType,
}) => {
  const { data, error } = await supabase.rpc("get_nc_date_trend", {
    start_date: startDate,
    end_date: endDate,
    override_period: overridePeriod,
    nc_type: ncType,
  });

  if (error) throw new Error(error.message);
  return data;
};

// Get all rows from a table
export const fetchAll = async (table) => {
  const { data, error } = await supabase.from(table).select("*");
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

// Delete a row
export const deleteRow = async (table, id) => {
  const { error } = await supabase.from(table).delete().eq("id", id);
  if (error) throw new Error(error.message);
};

export const getNextNCId = async (table, field) => {
  try {
    const year = new Date().getFullYear().toString().slice(-2); // e.g., '25'
    const prefix = `${table}-${year}-`;

    // Fetch the latest ID matching the prefix
    const { data, error } = await supabase
      .from(table)
      .select(field)
      .ilike(field, `${prefix}%`)
      .order(field, { ascending: false })
      .limit(1);

    if (error) {
      throw new Error(
        `Failed to fetch latest ${field} from ${table}: ${error.message}`
      );
    }

    let nextNumber = 1; // Start at 1
    if (data && data.length > 0) {
      const lastId = data[0][field];
      // Validate ID format (e.g., TABLE-YEAR-NNN)
      const match = lastId.match(new RegExp(`^${table}-${year}-(\\d{3})$`));
      if (!match) {
        throw new Error(
          `Invalid ${field} format: ${lastId}. Expected ${prefix}NNN`
        );
      }
      nextNumber = parseInt(match[1], 10) + 1;
    }

    // Generate and verify uniqueness
    let attempts = 0;
    const maxAttempts = 5; // Prevent infinite loops
    while (attempts < maxAttempts) {
      const nextId = `${prefix}${String(nextNumber).padStart(3, "0")}`; // e.g., NCM-25-002

      // Check if ID already exists
      const { data: existing, error: checkError } = await supabase
        .from(table)
        .select(field)
        .eq(field, nextId)
        .maybeSingle(); // Use maybeSingle to handle no rows

      if (checkError) {
        throw new Error(
          `Failed to verify ${field} uniqueness: ${checkError.message}`
        );
      }
      if (!existing) {
        return nextId; // ID is unique
      }

      // ID exists, try next number
      nextNumber++;
      attempts++;
    }

    throw new Error(
      `Unable to generate unique ${field} after ${maxAttempts} attempts`
    );
  } catch (error) {
    console.error(`Error in getNextNCId for ${table}.${field}:`, error);
    throw new Error(`Failed to generate next ${field}: ${error.message}`);
  }
};

/**
 * Uploads a file to Supabase Storage.
 * @param {File} file - The file to upload.
 * @param {string} bucket - The name of the storage bucket.
 * @returns {Promise<{ path: string, publicUrl: string }>}
 */
export const uploadFileToSupabase = async (file, bucket, id_ref) => {
  const actualFile = file.file ?? file; // unwrap if needed
  const fileName = actualFile.name || "unnamed_file";
  const filePath = `${id_ref}_${fileName}`;

  const { data, error } = await supabase.storage
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
  { file, path, id_ref, owner },
  tableName
) => {
  const { error } = await supabase.from(tableName).insert([
    {
      created_at: new Date().toISOString(),
      name: file.name,
      size: file.size,
      last_modified: new Date(file.lastModified).toISOString(),
      type: file.type,
      path,
      id_ref, // Optional reference to another table (e.g., NonConformance ID)
      owner,
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
 * @param {number} expiresIn - Expiration time in seconds (default 8 hours).
 * @returns {string|null} - Returns the signed URL or null if error.
 */
export const generateSignedUrl = async (
  bucket,
  filePath,
  expiresIn = 60 * 60 * 8
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
