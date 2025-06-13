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
