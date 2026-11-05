import { useNavigate } from "react-router-dom";
import { notificationLink, timeAgo } from "@/lib/notifications";
import { useMarkNotificationsRead } from "@/hooks/useNotifications";

const NotificationCard = ({ notification, closePane }) => {
  const navigate = useNavigate();
  const markRead = useMarkNotificationsRead();
  const link = notificationLink(notification);

  const open = () => {
    if (!notification.read) markRead.mutate({ ids: [notification.id] });
    if (link) {
      closePane();
      navigate(link);
    }
  };

  return (
    <div
      className={`flex gap-3 items-start p-3 border rounded-xl bg-secondary-bg ${notification.read ? "border-border-color" : "border-brand-primary/50"}`}>
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${notification.read ? "bg-transparent" : "bg-brand-primary"}`}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-primary-text">{notification.title}</h3>
          <span className="shrink-0 text-xs text-secondary-text">{timeAgo(notification.createdAt)}</span>
        </div>
        {notification.body && <p className="text-sm text-secondary-text break-words">{notification.body}</p>}
        <div className="mt-2 flex gap-3 text-sm">
          {link && (
            <button type="button" onClick={open} className="font-medium text-brand-primary hover:underline cursor-pointer">
              View
            </button>
          )}
          {!notification.read && (
            <button
              type="button"
              onClick={() => markRead.mutate({ ids: [notification.id] })}
              className="text-secondary-text hover:underline cursor-pointer">
              Mark as read
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default NotificationCard;
