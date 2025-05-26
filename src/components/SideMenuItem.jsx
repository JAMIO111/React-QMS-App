import React from "react";

const SideMenuItem = ({
  status,
  title,
  subtitle,
  icon: Icon,
  index,
  arrLength,
}) => {
  return (
    <div className="group cursor-pointer flex w-full justify-start pl-4 hover:bg-border-color/50 hover:border-border-color hover:border rounded-xl h-22 gap-2">
      <div className="flex justify-center pr-2 items-center h-full w-1/4">
        <div className="flex flex-col justify-center items-center h-full">
          <div
            className={`${
              index === 0 ? "bg-transparent" : "bg-brand-primary/70"
            } w-0.5 h-5`}></div>
          <div className="flex justify-center items-center rounded-full h-12 w-12 border-2 border-brand-primary text-success-color bg-brand-primary/50">
            <Icon className="h-6 w-6 text-white" />
          </div>
          <div
            className={`${
              index === arrLength - 1 ? "bg-transparent" : "bg-brand-primary/70"
            } w-0.5 h-5`}></div>
        </div>
      </div>
      <div className="flex flex-col justify-center h-full group-hover:translate-x-2 group-hover:transition-transform duration-200 w-3/4">
        <h4 className="text-left text-primary-text text-md font-semibold">
          {title}
        </h4>
        <h5 className="text-left text-secondary-text text-sm">{subtitle}</h5>
      </div>
    </div>
  );
};

export default SideMenuItem;
