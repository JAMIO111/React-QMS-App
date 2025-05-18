import supabase from "../supabase-client";

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
  const { data, error } = await supabase.from(table).insert([row]).single();
  if (error) throw new Error(error.message);
  return data;
};

// Update a row
export const updateRow = async (table, id, updates) => {
  const { data, error } = await supabase
    .from(table)
    .update(updates)
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return data;
};

// Delete a row
export const deleteRow = async (table, id) => {
  const { error } = await supabase.from(table).delete().eq("id", id);
  if (error) throw new Error(error.message);
};
