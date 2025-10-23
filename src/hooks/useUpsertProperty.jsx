import { useMutation, useQueryClient } from "@tanstack/react-query";
import supabase from "../supabase-client";

export const useUpsertProperty = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ propertyData, keyCodesForm, ownersForm }) => {
      const { KeyCodes = [], Owners = [], ...property } = propertyData;
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

      // --- KeyCodes Handling (as before) ---
      const newKeyCodes = [];
      const existingKeyCodes = [];

      (keyCodesForm || []).forEach((k) => {
        if (!k.created_at) {
          newKeyCodes.push({ ...k, property_id: propertyId });
        } else {
          existingKeyCodes.push({ ...k, property_id: propertyId });
        }
      });

      if (newKeyCodes.length > 0) {
        const { error: insertError } = await supabase
          .from("KeyCodes")
          .insert(newKeyCodes);
        if (insertError) throw insertError;
      }

      if (existingKeyCodes.length > 0) {
        const { error: upsertError } = await supabase
          .from("KeyCodes")
          .upsert(existingKeyCodes, { onConflict: "id" });
        if (upsertError) throw upsertError;
      }

      const { data: existingKeyCodesInDb, error: fetchKeyCodesError } =
        await supabase
          .from("KeyCodes")
          .select("id")
          .eq("property_id", propertyId);
      if (fetchKeyCodesError) throw fetchKeyCodesError;

      const currentKeyIds = (keyCodesForm || [])
        .map((k) => k.id)
        .filter(Boolean);
      const toDeleteKeyCodes = existingKeyCodesInDb.filter(
        (k) => !currentKeyIds.includes(k.id)
      );
      if (toDeleteKeyCodes.length > 0) {
        const { error: deleteError } = await supabase
          .from("KeyCodes")
          .delete()
          .in(
            "id",
            toDeleteKeyCodes.map((k) => k.id)
          );
        if (deleteError) throw deleteError;
      }

      // --- Owners Handling ---
      // ownersForm = [{ owner_id }]
      if (ownersForm && ownersForm.length > 0) {
        // Build payload with property_id
        const ownersPayload = ownersForm.map((o) => ({
          property_id: propertyId,
          owner_id: o.owner_id,
        }));

        // Upsert owners (on conflict by property_id + owner_id)
        const { error: ownersError } = await supabase
          .from("PropertyOwner")
          .upsert(ownersPayload, {
            onConflict: ["property_id", "owner_id"], // ensure you have this unique constraint in DB
          });

        if (ownersError) throw ownersError;
      }
    },

    onSuccess: (_, { propertyData }) => {
      const propertyId = propertyData.id;
      queryClient.invalidateQueries(["Properties"]);
      queryClient.invalidateQueries(["Property", propertyId]);
    },
  });
};
