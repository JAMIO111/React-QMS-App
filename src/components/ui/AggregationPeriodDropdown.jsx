import React, { useMemo } from "react";

const getAvailablePeriods = (startDate, endDate) => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

  if (isNaN(diffDays) || diffDays <= 0) return [];

  if (diffDays <= 2) return ["hour", "day"];
  if (diffDays <= 14) return ["day"];
  if (diffDays <= 60) return ["day", "week"];
  if (diffDays <= 180) return ["week", "month"];
  if (diffDays <= 365) return ["week", "month", "quarter"];
  return ["month", "quarter", "year"];
};

const AggregationPeriodDropdown = ({ value, onChange, validOptions }) => {
  const allOptions = ["hour", "day", "week", "month", "quarter", "year"];

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="ml-2 px-2 py-1 border border-border-color rounded-lg bg-text-input-color text-primary-text focus:outline-none focus:ring-2 focus:ring-brand-primary focus:border-transparent">
      {allOptions
        .filter((opt) => validOptions.includes(opt))
        .map((option) => (
          <option key={option} value={option}>
            {option[0].toUpperCase() + option.slice(1)}
          </option>
        ))}
    </select>
  );
};

export default AggregationPeriodDropdown;
