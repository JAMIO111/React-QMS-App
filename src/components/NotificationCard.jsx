import supabase from "@/supabase-client";
import CTAButton from "./CTAButton";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

const NotificationCard = ({ notification, closePane, userId }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return (
    <div className="flex bg-secondary-bg shadow-md gap-3 items-start p-3 border border-border-color rounded-xl">
      <div className="flex justify-center items-center border border-border-color rounded-full h-10 aspect-square">
        <img
          src={notification.avatar}
          alt={notification?.title}
          className="w-10 h-10 rounded-lg object-cover"
        />
      </div>
      <div className="flex flex-col justify-start items-start w-full">
        <div className="flex w-full justify-between items-center mb-1">
          <h3 className="font-semibold text-primary-text">
            {notification.title}
          </h3>
          <span className="text-xs text-secondary-text">
            {new Date(notification.delivered_at).toLocaleString("en-GB", {
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
        <p className="text-sm text-secondary-text">
          <span className="font-semibold text-sm">
            {notification.created_by}
          </span>{" "}
          {notification.body}{" "}
          <span className="font-semibold text-sm">{notification.doc_ref}</span>
        </p>
        <div className="flex w-full justify-start items-center mt-2 gap-3">
          {notification?.meta_data && (
            <CTAButton
              type="main"
              title="View"
              text={notification?.meta_data?.buttonText}
              textSize="text-sm"
              callbackFn={() => {
                closePane();
                navigate(notification?.meta_data?.url);
              }}
            />
          )}
          {notification.read ? null : (
            <CTAButton
              type="neutral"
              title="Mark as Read"
              text="Mark as Read"
              textSize="text-sm"
              callbackFn={async () => {
                console.log(
                  "Updating notification for:",
                  userId,
                  notification.id
                );
                const { data, error } = await supabase
                  .from("Notification Recipients")
                  .update({ read: true })
                  .eq("id", notification.id)
                  .eq("recipient_id", userId);

                if (error) {
                  console.error("Failed to mark as read:", error);
                  return;
                }

                console.log("Updated notification:", data);
                queryClient.invalidateQueries(["Notifications", userId]);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default NotificationCard;
