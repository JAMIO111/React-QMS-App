import { Link } from "react-router-dom";
import MenuCard from "../ui/MenuCard";
import Switch from "@/components/ui/Switch";
import { useReminderAreas, useSetReminderArea } from "../../hooks/useReminders";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";

/**
 * Settings → Notifications: which areas the daily reminders cover for me (WK2). Each switch moves at once and goes back if the save is refused. Whether the
 * reminders come in the app and by email is the "Reminders" group of the table below.
 */
const ReminderAreasCard = () => {
  const { data } = useReminderAreas();
  const set = useSetReminderArea();
  const { showToast } = useToast();
  if (!data) return null;
  return (
    <MenuCard
      title="Daily reminders"
      subtitle={`Once a day at ${data.reminderTime} (${data.timeZone}) you are told what of yours is overdue or due soon, and once when something first goes overdue. Switch off what you do not want to be reminded about.`}
      action={
        <Link to="/Reminders" className="text-sm text-link-color hover:underline">
          See my reminders
        </Link>
      }>
      <ul aria-label="Reminder areas" className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {data.data.map((a) => (
          <li key={a.area} className="flex items-start justify-between gap-3 rounded-xl border border-border-color px-3 py-2">
            <span className="flex flex-col">
              <span className="text-sm text-primary-text">{a.label}</span>
              <span className="text-xs text-secondary-text">
                {a.description} · from {a.soonDays} {a.soonDays === 1 ? "day" : "days"} before
              </span>
            </span>
            <Switch
              checked={a.enabled}
              aria-label={`Remind me about ${a.label}`}
              onChange={(e) =>
                set.mutate({ area: a.area, enabled: e.target.checked }, { onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) })
              }
            />
          </li>
        ))}
      </ul>
    </MenuCard>
  );
};

export default ReminderAreasCard;
