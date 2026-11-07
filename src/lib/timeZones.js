/** Every IANA time zone the browser knows (with UTC, which some browsers leave out). Falls back to a short list where the browser cannot list them. */
const FALLBACK = [
  "UTC", "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome", "Europe/Amsterdam", "Europe/Warsaw", "Europe/Athens",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto", "America/Sao_Paulo", "Asia/Dubai", "Asia/Kolkata",
  "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney", "Pacific/Auckland",
];

const supported = () => {
  try {
    const list = Intl.supportedValuesOf("timeZone");
    return list.length ? list : FALLBACK;
  } catch {
    return FALLBACK;
  }
};

export const TIME_ZONES = [...new Set(["UTC", ...supported()])].sort((a, b) => (a === "UTC" ? -1 : b === "UTC" ? 1 : a.localeCompare(b)));

/** The browser's own time zone, as a default (people can change it). */
export const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
};

/** Combo options for the time zones, plus the current value when it is not one of them (an older site keeps what it had). */
export const timeZoneOptions = (current) => {
  const zones = current && !TIME_ZONES.includes(current) ? [current, ...TIME_ZONES] : TIME_ZONES;
  return zones.map((z) => ({ id: z, name: z, hint: z === "UTC" ? "Coordinated Universal Time" : undefined }));
};
