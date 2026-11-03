import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import supabase from "../supabase-client";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function formatDate(dateInput, format = "dd/mm/yyyy") {
  if (!dateInput) return "Invalid date";

  const date = new Date(dateInput);
  if (isNaN(date)) return "Invalid date";

  const weekdays = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const map = {
    d: date.getDate(),
    dd: String(date.getDate()).padStart(2, "0"),
    ddd: weekdays[date.getDay()].slice(0, 3),
    dddd: weekdays[date.getDay()],
    m: date.getMonth() + 1,
    mm: String(date.getMonth() + 1).padStart(2, "0"),
    mmm: months[date.getMonth()].slice(0, 3),
    mmmm: months[date.getMonth()],
    yy: String(date.getFullYear()).slice(-2),
    yyyy: date.getFullYear(),
    H: date.getHours(),
    HH: String(date.getHours()).padStart(2, "0"),
    M: date.getMinutes(),
    MM: String(date.getMinutes()).padStart(2, "0"),
    S: date.getSeconds(),
    SS: String(date.getSeconds()).padStart(2, "0"),
  };

  return format.replace(
    /dddd|ddd|dd|d|mmmm|mmm|mm|m|yyyy|yy|HH|H|MM|M|SS|S/g,
    (match) => map[match]
  );
}

export const getFormattedFileDate = (file) => {
  if (!file) return "No date";

  let lastModified =
    file.last_modified ?? file.lastModified ?? file.lastModifiedDate;

  if (!lastModified) return "No date";

  let date;

  if (typeof lastModified === "number") {
    date = new Date(lastModified);
  } else {
    date = new Date(lastModified);
  }

  if (isNaN(date)) return "Invalid date";

  return date.toLocaleDateString();
};

export function stringToColor(str) {
  // Simple hash function (djb2)
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  hash = hash >>> 0; // Ensure positive number

  // Generate HSL color from hash
  const hue = hash % 360; // 0-359 degrees
  const saturation = 65; // fixed saturation %
  const lightness = 55; // fixed lightness %

  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

export function getPeriodLabel(startDate, endDate, periodType = "current") {
  const originalStart = new Date(startDate);
  const originalEnd = new Date(endDate);

  // Clone utility
  const cloneDate = (d) => new Date(d.getTime());

  const getWeekNumber = (date) => {
    const d = new Date(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
    );
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return weekNo;
  };

  const isSameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const isFullYear =
    originalStart.getMonth() === 0 &&
    originalEnd.getMonth() === 11 &&
    originalStart.getDate() === 1 &&
    originalEnd.getDate() === 31 &&
    originalStart.getFullYear() === originalEnd.getFullYear();

  const isFullMonth =
    originalStart.getDate() === 1 &&
    new Date(
      originalEnd.getFullYear(),
      originalEnd.getMonth() + 1,
      0
    ).getDate() === originalEnd.getDate() &&
    originalStart.getMonth() === originalEnd.getMonth() &&
    originalStart.getFullYear() === originalEnd.getFullYear();

  const getQuarter = (date) => Math.floor(date.getMonth() / 3) + 1;
  const getQuarterStart = (year, q) => new Date(year, (q - 1) * 3, 1);
  const getQuarterEnd = (year, q) => new Date(year, q * 3, 0);

  const isFullQuarter = (() => {
    const q = getQuarter(originalStart);
    return (
      originalStart.getDate() === 1 &&
      originalStart.getMonth() ===
        getQuarterStart(originalStart.getFullYear(), q).getMonth() &&
      isSameDay(originalEnd, getQuarterEnd(originalStart.getFullYear(), q))
    );
  })();

  const isFullWeek = (() => {
    const s = cloneDate(originalStart);
    const e = cloneDate(originalEnd);
    const isMonday = s.getDay() === 1;
    const isSunday = e.getDay() === 0;
    const diff = (e - s) / (1000 * 60 * 60 * 24);
    return isMonday && isSunday && diff === 6;
  })();

  let start = cloneDate(originalStart);
  let end = cloneDate(originalEnd);

  // Apply previous logic
  if (periodType === "previous") {
    if (isFullYear) {
      start = new Date(originalStart.getFullYear() - 1, 0, 1);
      end = new Date(originalStart.getFullYear() - 1, 11, 31);
    } else if (isFullQuarter) {
      const q = getQuarter(originalStart);
      const year =
        q === 1 ? originalStart.getFullYear() - 1 : originalStart.getFullYear();
      const prevQ = q === 1 ? 4 : q - 1;
      start = getQuarterStart(year, prevQ);
      end = getQuarterEnd(year, prevQ);
    } else if (isFullMonth) {
      const month =
        originalStart.getMonth() === 0 ? 11 : originalStart.getMonth() - 1;
      const year =
        originalStart.getMonth() === 0
          ? originalStart.getFullYear() - 1
          : originalStart.getFullYear();
      start = new Date(year, month, 1);
      end = new Date(year, month + 1, 0);
    } else if (isFullWeek) {
      const newStart = new Date(originalStart);
      newStart.setDate(newStart.getDate() - 7);
      start = newStart;
      end = new Date(newStart);
      end.setDate(end.getDate() + 6);
    } else {
      const daysDiff = Math.round(
        (originalEnd - originalStart) / (1000 * 60 * 60 * 24)
      );
      start.setDate(originalStart.getDate() - (daysDiff + 1));
      end.setDate(originalEnd.getDate() - (daysDiff + 1));
    }
  }

  const formatMonth = (date) =>
    date.toLocaleDateString("en-GB", { month: "short" });
  const formatYear = (date) => date.getFullYear();

  if (isFullYear) return `${formatYear(start)}`;
  if (isFullQuarter) return `Q${getQuarter(start)} ${formatYear(start)}`;
  if (isFullMonth) return `${formatMonth(start)} ${formatYear(start)}`;
  if (isFullWeek) return `Week ${getWeekNumber(start)} ${formatYear(start)}`;

  const sameMonth = start.getMonth() === end.getMonth();
  const sameYear = start.getFullYear() === end.getFullYear();

  if (sameMonth && sameYear) {
    if (start.getDate() === end.getDate()) {
      return `${start.getDate()} ${formatMonth(start)} ${formatYear(start)}`;
    }
    return `${start.getDate()}–${end.getDate()} ${formatMonth(
      start
    )} ${formatYear(start)}`;
  }

  if (sameYear) {
    return `${start.getDate()} ${formatMonth(
      start
    )} – ${end.getDate()} ${formatMonth(end)} ${formatYear(start)}`;
  }

  return `${start.getDate()} ${formatMonth(start)} ${formatYear(
    start
  )} – ${end.getDate()} ${formatMonth(end)} ${formatYear(end)}`;
}
