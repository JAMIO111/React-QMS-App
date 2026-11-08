import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useNotification } from "../contexts/NotificationProvider";
import { XIcon } from "@/components/icons";
import SlidingToggle from "./ui/SlidingToggle";
import NotificationCard from "./NotificationCard";
import {
  useMarkNotificationsRead,
  useNotifications,
} from "../hooks/useNotifications";
import LoadingScreen from "./ui/LoadingScreen";

/** Full-height drawer that slides in from the right, like the filter pane. */
const Drawer = ({ onClose }) => {
  const [typeFilter, setTypeFilter] = useState("New");
  const [closing, setClosing] = useState(false);
  const paneRef = useRef(null);
  const { data, isLoading, isError } = useNotifications();
  const markRead = useMarkNotificationsRead();
  const notifications = data?.data;

  // Slide out, then let the provider remove the drawer.
  const close = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 180);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const onKey = (e) =>
      e.key === "Escape" && !e.defaultPrevented && closeRef.current();
    document.addEventListener("keydown", onKey);
    paneRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const shown = (notifications ?? []).filter((n) =>
    typeFilter === "All" ? true : typeFilter === "New" ? !n.read : n.read,
  );

  return (
    <div className="fixed inset-0 z-[9000]">
      <div
        aria-hidden="true"
        onMouseDown={close}
        className={`absolute inset-0 bg-black/30 ${closing ? "animate-out fade-out" : "animate-in fade-in"} duration-200 fill-mode-forwards`}
      />
      <aside
        ref={paneRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        className={`absolute inset-y-0 right-0 flex h-dvh w-[36rem] max-w-full flex-col border-l border-border-color bg-primary-bg text-primary-text shadow-2xl shadow-shadow-color outline-none ${
          closing
            ? "animate-out slide-out-to-right"
            : "animate-in slide-in-from-right"
        } duration-200 ease-out fill-mode-forwards`}
      >
        <div className="flex shrink-0 flex-row items-center justify-between border-b border-border-color bg-secondary-bg px-4 py-3">
          <h3 className="text-xl">Notifications</h3>
          <button
            type="button"
            aria-label="Close notifications"
            className="cursor-pointer rounded-md p-1 hover:bg-primary-bg hover:text-error-color"
            onClick={close}
          >
            <XIcon />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          <SlidingToggle ariaLabel="Show notifications" options={["All", "New", "Read"]} value={typeFilter} onChange={setTypeFilter} className="w-full [&>button]:flex-1" />
          <div className="flex items-center justify-between text-sm">
            <Link
              to="/Settings/Notifications"
              onClick={close}
              className="text-brand-primary hover:underline"
            >
              Notification settings
            </Link>
            {data?.unread > 0 && (
              <button
                type="button"
                onClick={() => markRead.mutate({ all: true })}
                className="cursor-pointer text-secondary-text hover:underline"
              >
                Mark all as read
              </button>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {isLoading ? (
              <LoadingScreen size="sm" />
            ) : isError ? (
              <div className="rounded-xl border border-dashed border-border-color/50 p-6 text-center text-error-color">
                Error loading notifications.
              </div>
            ) : shown.length > 0 ? (
              shown.map((n) => (
                <NotificationCard
                  key={n.id}
                  notification={n}
                  closePane={close}
                />
              ))
            ) : (
              <div className="rounded-xl border border-dashed border-border-color/50 p-6 text-center text-secondary-text">
                No Notifications to show.
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
};

const NotificationPane = () => {
  const { isOpen, closePane } = useNotification();
  const root =
    typeof window === "undefined"
      ? null
      : document.getElementById("notification-root");
  if (!root || !isOpen) return null;
  return createPortal(<Drawer onClose={closePane} />, root);
};

export default NotificationPane;
