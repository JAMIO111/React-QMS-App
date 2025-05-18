import { useEffect, useState } from "react";
import supabase from "../supabase-client";

export default function useSupabaseSearch({
  table,
  searchTerm = "",
  searchFields = [],
  orderBy = "created_at",
}) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!table || !orderBy) return;

    const fetchData = async () => {
      setLoading(true);
      setError(null);

      try {
        let query = supabase.from(table).select("*");

        if (searchTerm && searchTerm.trim() !== "") {
          const orConditions = searchFields
            .map((field) => {
              if (field === "id") {
                return /^\d+$/.test(searchTerm)
                  ? `${field}.eq.${searchTerm}`
                  : null;
              }
              return `${field}.ilike.*${searchTerm}*`;
            })
            .filter(Boolean)
            .join(",");

          query = query.or(orConditions);
        }

        const { data, error } = await query;

        if (error) throw error;

        setData(data);
      } catch (err) {
        console.error("Supabase search error:", err);
        setError(err.message || "An error occurred");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [table, searchTerm, searchFields, orderBy]);

  return { data, loading, error };
}
