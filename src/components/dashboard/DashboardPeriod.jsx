import { format, startOfDay, subDays } from "date-fns";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { DASHBOARD_PERIODS, MAX_PERIOD_DAYS } from "@/lib/dashboardPeriod";

/**
 * The period field for a dashboard's header. It opens on the preset list (This month, Last quarter, Last year…);
 * "Custom range" switches to the calendar to choose any two days, up to today and at most three years back.
 */
export const DashboardPeriodPicker = ({ period, className = "w-56" }) => {
  const today = startOfDay(new Date());
  return (
    <RHFDatePickerPopout
      className={className}
      label="Period"
      mode="range"
      valueFormat="iso"
      value={{ from: format(period.from, "yyyy-MM-dd"), to: format(period.to, "yyyy-MM-dd") }}
      onChange={(r) => r?.from && r?.to && period.setRange({ from: r.from, to: r.to })}
      presets={DASHBOARD_PERIODS}
      presetsOpen
      quickPresets={0}
      allowFuture={false}
      showMonth="end"
      minDate={subDays(today, MAX_PERIOD_DAYS)}
      formatValue={() => period.label}
    />
  );
};
