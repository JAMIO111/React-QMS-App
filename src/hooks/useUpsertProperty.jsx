import { useMutation, useQueryClient } from "@tanstack/react-query";
import supabase from "../supabase-client";

export const useUpsertProperty = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (propertyData) => {
      const { KeyCodes, ...property } = propertyData;
      let propertyId = property.id;

      // 1️⃣ Upsert or insert the property first
      let result;
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

      // 2️⃣ Handle KeyCodes (this is where your code goes)
      if (Array.isArray(KeyCodes)) {
        const keyCodesWithPropId = KeyCodes.map((k) => ({
          ...k,
          property_id: propertyId,
        }));

        const newKeyCodes = keyCodesWithPropId.filter((k) => !k.id); // new ones
        const existingKeyCodes = keyCodesWithPropId.filter((k) => k.id); // edits

        // Upsert existing key codes
        if (existingKeyCodes.length) {
          const { error: updateError } = await supabase
            .from("KeyCodes")
            .upsert(existingKeyCodes, { onConflict: "id" });
          if (updateError) throw updateError;
        }

        // Insert new key codes
        if (newKeyCodes.length) {
          const { error: insertError } = await supabase
            .from("KeyCodes")
            .insert(newKeyCodes);
          if (insertError) throw insertError;
        }

        // Delete removed key codes
        const { data: existingInDb, error: fetchError } = await supabase
          .from("KeyCodes")
          .select("id")
          .eq("property_id", propertyId);
        if (fetchError) throw fetchError;

        const currentIds = KeyCodes.map((k) => k.id).filter(Boolean);
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
      }

      return result;
    },

    onSuccess: () => {
      queryClient.invalidateQueries(["Properties"]);
      queryClient.invalidateQueries(["Property", propertyId]);
    },
  });
};
