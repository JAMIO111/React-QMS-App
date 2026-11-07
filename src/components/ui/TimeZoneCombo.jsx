import { useMemo } from "react";
import { GlobeIcon } from "@/components/icons";
import { timeZoneOptions } from "../../lib/timeZones";
import RHFComboBox from "./RHFComboBox";

/** Time zone picker: a searchable list of every IANA zone (e.g. Europe/London). `value` is the zone name; `onChange(zone | null)`. Takes RHFComboBox's other props. */
const TimeZoneCombo = ({ label = "Time zone", value, ...props }) => {
  const options = useMemo(() => timeZoneOptions(value), [value]);
  return <RHFComboBox icon={GlobeIcon} placeholder="Search time zones, e.g. Europe/London" label={label} options={options} value={value || null} sort={false} {...props} />;
};

export default TimeZoneCombo;
