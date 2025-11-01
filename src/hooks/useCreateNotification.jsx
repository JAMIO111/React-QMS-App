import { useCallback } from "react";
import supabase from "../supabase-client";
import { useUser } from "../contexts/UserProvider";

export function useCreateNotification() {
  const { profile } = useUser();
  const createNotification = useCallback(
    async ({ title, body, metaData = {}, docRef }) => {
      // Step 1: Create the notification
      if (!profile) {
        throw new Error("User profile is not available");
      }
      const orgId = profile.organisation_id;
      const authId = profile.auth_id;
      const { data: notif, error: notifError } = await supabase
        .from("Notifications")
        .insert([
          {
            created_by: authId,
            title,
            body,
            meta_data: metaData,
            doc_ref: docRef,
          },
        ])
        .select()
        .single();

      if (notifError)
        throw new Error(`Failed to create notification: ${notifError.message}`);

      // Step 2: Get all users in the org
      const { data: users, error: userError } = await supabase
        .from("Employees")
        .select("auth_id")
        .eq("notifications", true);

      if (userError)
        throw new Error(`Failed to get users: ${userError.message}`);

      // Step 3: Insert recipients
      const recipientInserts = users.map((u) => ({
        notification_id: notif.id,
        recipient_id: u.auth_id,
        read: false,
      }));

      const { error: recipientError } = await supabase
        .from("Notification Recipients")
        .insert(recipientInserts);

      if (recipientError)
        throw new Error(
          `Failed to assign recipients: ${recipientError.message}`
        );

      return notif;
    },
    []
  );

  return { createNotification };
}
