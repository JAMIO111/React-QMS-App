import { createPortal } from "react-dom";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNotification } from "../contexts/NotificationProvider";
import { CgClose } from "react-icons/cg";
import SlidingSelectorGeneric from "./ui/SlidingSelectorGeneric";
import NotificationCard from "./NotificationCard";
import { useNotifications } from "../hooks/useNotifications";
import { useUser } from "../contexts/UserProvider";

const NotificationPane = () => {
  const { profile } = useUser();
  const { isOpen, content, closePane } = useNotification();
  const [typeFilter, setTypeFilter] = useState("New");

  const { data: notifications, isLoading, isError } = useNotifications();
  console.log("Notifications:", notifications);

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
            className="w-120 max-w-full h-full bg-primary-bg p-4 shadow-s border border-border-color/50 rounded-2xl"
            onClick={(e) => e.stopPropagation()} // Prevent backdrop close when clicking inside
          >
            <div className="flex justify-between items-center mb-3 text-primary-text">
              <h2 className="text-lg font-semibold">Notifications</h2>
              <button
                className="hover:bg-border-color transition-colors duration-300 rounded-md cursor-pointer p-1.5"
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
                      userId={profile.auth_id}
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
