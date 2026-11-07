import React from "react";

const AggregationPeriodDropdown = ({ value, onChange, validOptions }) => {
  const allOptions = ["hour", "day", "week", "month", "quarter", "year"];

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="ml-2 px-2 py-1 border border-border-color rounded-lg bg-text-input-color text-sm text-primary-text focus:outline-none focus:ring-2 focus:ring-brand-primary focus:border-transparent">
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
