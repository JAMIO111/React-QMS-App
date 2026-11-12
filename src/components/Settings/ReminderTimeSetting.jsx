import { useEffect, useState } from "react";
import MenuCard from "../ui/MenuCard";
import ComboField from "../ui/ComboField";
import TimeZoneCombo from "../ui/TimeZoneCombo";
import CTAButton from "@/components/CTAButton";
import { useUpdateOrganisation } from "../../hooks/useQmsApi";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { REMINDER_TIMES } from "../../lib/reminders";

/**
 * Settings → Organisation: when the daily reminders go out, and the organisation's own day (WK2, W10). No zone set = the first site's. "Today", "due soon"
 * and "overdue" in the reminders are worked out in this zone; what each person sees on screen still follows their own browser.
 */
const ReminderTimeSetting = ({ settings, canManage }) => {
  const update = useUpdateOrganisation();
  const { showToast } = useToast();
  const [time, setTime] = useState(settings.reminderTime ?? "07:00");
  const [zone, setZone] = useState(settings.timeZone ?? null);
  useEffect(() => {
    setTime(settings.reminderTime ?? "07:00");
    setZone(settings.timeZone ?? null);
  }, [settings.reminderTime, settings.timeZone]);
  const changed = time !== (settings.reminderTime ?? "07:00") || zone !== (settings.timeZone ?? null);
  const times = REMINDER_TIMES.some((t) => t.value === time) ? REMINDER_TIMES : [...REMINDER_TIMES, { value: time, label: time }];

  const save = () =>
    update.mutate(
      { body: { settings: { reminderTime: time, timeZone: zone } }, reason: `Daily reminders at ${time}${zone ? ` (${zone})` : ""}` },
      {
        onSuccess: () => showToast({ type: "success", title: "Saved", message: "Daily reminder time updated." }),
        onError: (e) => showToast({ type: "error", title: "Not saved", message: describeApiError(e) }),
      },
    );

  return (
    <MenuCard title="Daily reminders" subtitle="When everyone is told what of theirs is overdue or due soon, and the time zone the organisation's day is kept in" bodyClassName="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ComboField label="Send at" value={time} onChange={(v) => setTime(v ?? "07:00")} options={times} disabled={!canManage} required />
        <TimeZoneCombo
          label="Time zone"
          value={zone}
          onChange={(v) => setZone(v ?? null)}
          disabled={!canManage}
          clearable
          hint={zone ? undefined : `Not set: the first site's zone is used (${settings.effectiveTimeZone ?? "Europe/London"})`}
        />
      </div>
      {canManage && (
        <CTAButton type="main" size="md" className="self-start" disabled={!changed || update.isPending} loading={update.isPending} onClick={save}>
          Save reminder time
        </CTAButton>
      )}
    </MenuCard>
  );
};

export default ReminderTimeSetting;
