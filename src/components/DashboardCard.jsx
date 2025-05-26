import React from "react";

const DashboardCard = ({
  title = "Title",
  icon: Icon,
  value = "123,456.78",
  trend = 25,
  isSelected = false,
  onClick,
}) => {
  return (
    <div
      onClick={onClick}
      className={`${
        isSelected
          ? "bg-gradient-to-bl from-cta-color to-cta-color/80 "
          : "bg-secondary-bg"
      } flex border border-border-color flex-col justify-around px-4 py-2 h-full w-full rounded-lg`}>
      <div className="flex flex-row justify-start items-center">
        <Icon
          className={`${
            isSelected ? "text-white" : "text-cta-color"
          } h-5 w-5 text-cta-color`}
        />
        <h2
          className={`${
            isSelected ? "text-white" : "text-secondary-text"
          } text-lg ml-2`}>
          {title}
        </h2>
      </div>
      <div className="flex flex-row justify-start items-center">
        <h3
          className={`${
            isSelected ? "text-white" : "text-primary-text"
          } text-2xl`}>
          {value}
        </h3>
        {trend && (
          <span
            className={`ml-3 px-1 rounded text-md
      ${
        isSelected
          ? "text-white bg-white/20"
          : trend > 0
          ? "text-success-color bg-success-color/10"
          : "text-error-color bg-error-color/10"
      }`}>
            {trend > 0 ? `+${trend}%` : `${trend}%`}
          </span>
        )}
      </div>
    </div>
  );
};

export default DashboardCard;
