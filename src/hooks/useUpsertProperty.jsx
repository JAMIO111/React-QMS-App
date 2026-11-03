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
      if (ownersForm && ownersForm.length > 0) {
        // Filter out any invalid owners without an owner_id
        const validOwners = ownersForm.filter((o) => o.id);

        if (validOwners.length > 0) {
          const ownersPayload = validOwners.map((o) => ({
            property_id: propertyId,
            owner_id: o.id,
          }));

          // 1. Upsert valid owners
          const { error: ownersError } = await supabase
            .from("PropertyOwner")
            .upsert(ownersPayload, {
              onConflict: ["property_id", "owner_id"],
            });
          if (ownersError) throw ownersError;
        }

        // 2. Delete removed owners (only consider valid ones)
        const formOwnerIds = ownersForm.map((o) => o.id).filter(Boolean);
        const { data: existingOwners, error: fetchError } = await supabase
          .from("PropertyOwner")
          .select("owner_id")
          .eq("property_id", propertyId);
        if (fetchError) throw fetchError;

        const ownersToDelete = existingOwners
          .filter((o) => !formOwnerIds.includes(o.owner_id))
          .map((o) => o.owner_id);

        if (ownersToDelete.length > 0) {
          const { error: deleteError } = await supabase
            .from("PropertyOwner")
            .delete()
            .eq("property_id", propertyId)
            .in("owner_id", ownersToDelete);
          if (deleteError) throw deleteError;
        }
      }
    },

    onSuccess: (_, { propertyData }) => {
      const propertyId = propertyData.id;
      queryClient.invalidateQueries(["Properties"]);
      queryClient.invalidateQueries(["Property", propertyId]);
    },
  });
};
