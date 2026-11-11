import { format, startOfDay, subDays } from "date-fns";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { DASHBOARD_PERIODS, MAX_PERIOD_DAYS } from "@/lib/dashboardPeriod";

/**
 * The period field for a dashboard's header. It opens on the preset list (This month, Last quarter, Last year…);
 * "Custom range" switches to the calendar to choose any two days, up to today and at most three years back.
 */
export const DashboardPeriodPicker = ({ period, className = "w-60" }) => {
  const today = startOfDay(new Date());
  return (
    // A fixed-width box, so the field never changes size when the period (and so its words) changes.
    <div className={`${className} shrink-0`}>
      <RHFDatePickerPopout
        label="Period"
        mode="range"
        valueFormat="iso"
        value={{
          from: format(period.from, "yyyy-MM-dd"),
          to: format(period.to, "yyyy-MM-dd"),
        }}
        onChange={(r) =>
          r?.from && r?.to && period.setRange({ from: r.from, to: r.to })
        }
        presets={DASHBOARD_PERIODS}
        presetsOpen
        quickPresets={0}
        allowFuture={false}
        showMonth="end"
        minDate={subDays(today, MAX_PERIOD_DAYS)}
        formatValue={() => period.label}
        panelWidth="28rem"
      />
    </div>
  );
};
