import React from "react";

const SideMenuItem = ({
  isCreating,
  title,
  subtitle,
  icon: Icon,
  index,
  arrLength,
}) => {
  return (
    <div className="group cursor-pointer flex w-full gap-1 pl-2 justify-start hover:bg-border-color/50 hover:border-border-color hover:border hover:pr-1 rounded-xl h-22">
      <div className="flex justify-center items-center h-full w-1/4">
        <div className="flex flex-col justify-center items-center h-full">
          <div
            className={`${
              index === 0 ? "bg-transparent" : "bg-brand-primary/70"
            } w-0.5 h-5`}></div>
          <div
            className={`${
              isCreating && index !== 0
                ? "border-border-dark-color bg-border-color/20"
                : "border-brand-primary bg-brand-primary/50"
            } flex justify-center items-center rounded-xl h-12 w-12 border-2`}>
            <Icon
              className={`${
                isCreating && index !== 0 ? "text-secondary-text" : "text-white"
              } h-6 w-6`}
            />
          </div>
          <div
            className={`${
              index === arrLength - 1 ? "bg-transparent" : "bg-brand-primary/70"
            } w-0.5 h-5`}></div>
        </div>
      </div>
      <div className="flex flex-col justify-center h-full group-hover:translate-x-1.5 group-hover:transition-transform duration-200 w-3/4">
        <h4 className="text-left text-primary-text text-md font-semibold">
          {title}
        </h4>
        <h5 className="text-left text-secondary-text text-xs">{subtitle}</h5>
      </div>
    </div>
  );
};

export default SideMenuItem;
