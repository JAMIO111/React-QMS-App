import { useMutation, useQueryClient } from "@tanstack/react-query";
import supabase from "../supabase-client";

export const useUpsertProperty = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ propertyData, keyCodesForm }) => {
      const { KeyCodes = [], ...property } = propertyData;
      let propertyId = property.id;
      let result;

      // 1️⃣ Upsert or insert property
      if (propertyId) {
        const { data, error } = await supabase
          .from("Properties")
          .update(property)
          .eq("id", propertyId)
          .select()
          .single();
        if (error) throw error;
        result = data;
      } else {
        const { data, error } = await supabase
          .from("Properties")
          .insert(property)
          .select()
          .single();
        if (error) throw error;
        propertyId = data.id;
        result = data;
      }

      // 2️⃣ Split KeyCodes: new vs existing
      const newKeyCodes = [];
      const existingKeyCodes = [];

      (keyCodesForm || []).forEach((k) => {
        if (!k.created_at) {
          // Treat client-generated temp IDs as new
          const { id, ...clean } = k;
          newKeyCodes.push({ ...k, property_id: propertyId });
        } else {
          existingKeyCodes.push({ ...k, property_id: propertyId });
        }
      });

      // 3️⃣ Insert new KeyCodes (Postgres handles created_at)
      if (newKeyCodes.length > 0) {
        console.log("Inserting new KeyCodes:", newKeyCodes);
        const { error: insertError } = await supabase
          .from("KeyCodes")
          .insert(newKeyCodes)
          .select("id"); // optional: get DB-generated IDs
        if (insertError) throw insertError;
      }

      // 4️⃣ Upsert existing KeyCodes
      if (existingKeyCodes.length > 0) {
        console.log("Upserting existing KeyCodes:", existingKeyCodes);
        const { error: upsertError } = await supabase
          .from("KeyCodes")
          .upsert(existingKeyCodes, { onConflict: "id" });
        if (upsertError) throw upsertError;
      }

      // 5️⃣ Delete removed KeyCodes
      const { data: existingInDb, error: fetchError } = await supabase
        .from("KeyCodes")
        .select("id")
        .eq("property_id", propertyId);
      if (fetchError) throw fetchError;

      const currentIds = (keyCodesForm || []).map((k) => k.id).filter(Boolean);
      const toDelete = existingInDb.filter((k) => !currentIds.includes(k.id));

      if (toDelete.length > 0) {
        const { error: deleteError } = await supabase
          .from("KeyCodes")
          .delete()
          .in(
            "id",
            toDelete.map((k) => k.id)
          );
        if (deleteError) throw deleteError;
      }

      return result;
    },

    onSuccess: (_, { propertyData }) => {
      const propertyId = propertyData.id;
      queryClient.invalidateQueries(["Properties"]);
      queryClient.invalidateQueries(["Property", propertyId]);
    },
  });
};
