import { useMutation, useQueryClient } from "@tanstack/react-query";
import supabase from "../supabase-client";

export const useUpsertOwner = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (ownerData) => {
      let ownerId = ownerData.id;
      let result;

      if (ownerId) {
        // Update existing owner
        const { data, error } = await supabase
          .from("Owners")
          .update(ownerData)
          .eq("id", ownerId)
          .select()
          .single();

        if (error) throw error;
        result = data;
      } else {
        // Insert new owner
        const { data, error } = await supabase
          .from("Owners")
          .insert(ownerData)
          .select()
          .single();

        if (error) throw error;
        ownerId = data.id;
        result = data;
      }

      return result; // return so onSuccess can access it
    },

    onSuccess: (result) => {
      // result contains the inserted or updated owner
      queryClient.invalidateQueries(["Owners"]);
      queryClient.invalidateQueries(["Owner", result.id]);
    },
  });
};
