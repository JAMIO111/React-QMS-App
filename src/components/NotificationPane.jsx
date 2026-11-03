import { createPortal } from "react-dom";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNotification } from "../contexts/NotificationProvider";
import { CgClose } from "react-icons/cg";
import SlidingSelectorGeneric from "./ui/SlidingSelectorGeneric";
import NotificationCard from "./NotificationCard";
import supabase from "../supabase-client";
import { useUser } from "../contexts/UserProvider";
import { useQuery } from "@tanstack/react-query";

const NotificationPane = () => {
  const { isOpen, content, closePane } = useNotification();
  const [typeFilter, setTypeFilter] = useState("All");
  const { profile } = useUser();

  const {
    data: notifications,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["userNotifications", profile?.auth_id],
    queryFn: async () => {
      if (!profile?.auth_id) return [];
      const { data, error } = await supabase.rpc("get_user_notifications", {
        user_id: profile.auth_id,
      });
      if (error) {
        console.error("RPC Error:", error);
        throw new Error(error.message);
      }
      if (!data || data.length === 0) {
        console.warn("RPC returned no data.");
      }
      return data;
    },
    enabled: !!profile?.auth_id, // don't run until auth ID is available
  });

  if (typeof window === "undefined") return null;
  const root = document.getElementById("notification-root");
  if (!root) return null;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed p-5 inset-0 z-50 flex justify-end bg-black/30"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={closePane} // Clicking the backdrop closes the pane
        >
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.3 }}
            className="w-120 max-w-full h-full bg-primary-bg shadow-lg p-4 border border-border-color rounded-2xl"
            onClick={(e) => e.stopPropagation()} // Prevent backdrop close when clicking inside
          >
            <div className="flex justify-between items-center mb-3 text-primary-text">
              <h2 className="text-lg font-semibold">Notifications</h2>
              <button
                className="hover:bg-border-color rounded-md cursor-pointer p-1.5"
                onClick={closePane}>
                <CgClose />
              </button>
            </div>
            <SlidingSelectorGeneric
              options={["All", "New", "Read"]}
              value={typeFilter}
              onChange={setTypeFilter}
              notifications={notifications}
            />
            <div className="mt-4 flex flex-col gap-2">
              {isLoading ? (
                <div className="flex-col text-center items-center justify-center text-secondary-text border border-dashed border-border-color/50 p-6 rounded-xl">
                  Loading Notifications...
                </div>
              ) : isError ? (
                <div className="flex-col text-center items-center justify-center text-error-color border border-dashed border-border-color/50 p-6 rounded-xl">
                  Error loading notifications.
                </div>
              ) : notifications && notifications.length > 0 ? (
                notifications
                  .filter((notification) => {
                    if (typeFilter === "All") return true;
                    if (typeFilter === "New")
                      return notification.read === false;
                    if (typeFilter === "Read")
                      return notification.read === true;
                    return true;
                  })
                  .map((notification) => (
                    <NotificationCard
                      key={notification.id}
                      notification={notification}
                      closePane={closePane}
                    />
                  ))
              ) : (
                <div className="flex-col text-center items-center justify-center text-secondary-text border border-dashed border-border-color/50 p-6 rounded-xl">
                  No Notifications to show.
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    root
  );
};

export default NotificationPane;
