import RHFDatePickerPopout from "./RHFDatePickerPopout";

const PAST = ["today", "yesterday", "last7", "last30", "last90", "thisWeek", "lastWeek", "thisMonth", "lastMonth", "thisQuarter", "lastQuarter", "thisYear", "lastYear"];
const AHEAD = ["today", "next7", "next30", "next90", "thisWeek", "nextWeek", "thisMonth", "nextMonth", "thisQuarter", "nextQuarter", "thisYear"];

/**
 * The date range field of a register's filter: one picker for "from" and "to" together, opening on the presets (This month, Last
 * quarter, Last year…) with "Custom range" for any two days. Used by the filter panes of the registers and their inline filters.
 *
 *   <DateRangeFilter label="Detected" from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }} />
 *
 * `from` / `to` are "yyyy-MM-dd" strings or empty; `onChange` gets both (null when cleared). `direction` is "past" (the default: dates
 * that have happened, so no days after today and look-back presets) or "future" (due dates: any day, and look-ahead presets).
 * A range with only one end (an old link) shows as "From …" / "Until …" until it is changed or cleared.
 */
const DateRangeFilter = ({ label, from, to, onChange, direction = "past", placeholder = "Any date", className = "" }) => {
  const ahead = direction === "future";
  return (
    <RHFDatePickerPopout
      className={className}
      label={label}
      placeholder={placeholder}
      mode="range"
      valueFormat="iso"
      clearable
      value={from || to ? { from: from || null, to: to || null } : null}
      onChange={(r) => onChange({ from: r?.from ?? null, to: r?.to ?? null })}
      presets={ahead ? AHEAD : PAST}
      presetsOpen
      quickPresets={0}
      allowFuture={ahead}
      showMonth={ahead ? "start" : "end"}
      panelWidth="28rem"
    />
  );
};

export default DateRangeFilter;
