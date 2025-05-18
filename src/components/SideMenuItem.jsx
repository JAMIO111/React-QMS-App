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
    <div className="cursor-pointer flex w-full justify-end hover:bg-border-color rounded-xl h-18 gap-2">
      <div className="flex flex-col justify-center h-full">
        <h4 className="text-right text-primary-text text-md font-semibold">
          {title}
        </h4>
        <h5 className="text-right text-secondary-text text-sm">{subtitle}</h5>
      </div>
      <div className="flex justify-center pr-2 items-center h-full w-1/4">
        <div className="flex flex-col justify-center items-center h-full">
          <div
            className={`${
              index === 0 ? "bg-transparent" : "bg-brand-primary/70"
            } w-0.5 h-3`}></div>
          <div className="flex justify-center items-center rounded-full h-12 w-12 border-2 border-brand-primary text-success-color bg-brand-primary/50">
            <Icon className="h-6 w-6 text-white" />
          </div>
          <div
            className={`${
              index === arrLength - 1 ? "bg-transparent" : "bg-brand-primary/70"
            } w-0.5 h-3`}></div>
        </div>
      </div>
    </div>
  );
};

export default SideMenuItem;
