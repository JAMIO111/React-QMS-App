import { createPortal } from "react-dom";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNotification } from "../contexts/NotificationProvider";
import { XIcon } from "@/components/icons";
import SlidingSelectorGeneric from "./ui/SlidingSelectorGeneric";
import NotificationCard from "./NotificationCard";
import { useMarkNotificationsRead, useNotifications } from "../hooks/useNotifications";
import { Link } from "react-router-dom";
import LoadingScreen from "./ui/LoadingScreen";

const NotificationPane = () => {
  const { isOpen, closePane } = useNotification();
  const [typeFilter, setTypeFilter] = useState("New");

  const { data, isLoading, isError } = useNotifications();
  const markRead = useMarkNotificationsRead();
  const notifications = data?.data;

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
                <XIcon />
              </button>
            </div>
            <SlidingSelectorGeneric
              options={["All", "New", "Read"]}
              value={typeFilter}
              onChange={setTypeFilter}
            />
            <div className="mt-3 flex items-center justify-between text-sm">
              <Link to="/Settings/Notifications" onClick={closePane} className="text-brand-primary hover:underline">
                Notification settings
              </Link>
              {data?.unread > 0 && (
                <button
                  type="button"
                  onClick={() => markRead.mutate({ all: true })}
                  className="text-secondary-text hover:underline cursor-pointer">
                  Mark all as read
                </button>
              )}
            </div>
            <div className="mt-4 flex flex-col gap-2">
              {isLoading ? (
                <LoadingScreen size="sm" />
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
