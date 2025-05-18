import React from "react";
import clsx from "clsx";

const CTAButton = ({ type, text, icon: Icon, callbackFn }) => {
  const colorClasses = {
    cancel:
      "border border-error-color text-error-color hover:bg-error-color hover:text-white",
    main: "bg-cta-color text-white",
  };
  const baseClass =
    "flex flex-row gap-2 py-1 px-2 items-center justify-center rounded-lg active:scale-97 transition-transform duration-200 ease-in-out cursor-pointer";
  return (
    <button
      onClick={callbackFn}
      className={clsx(baseClass, colorClasses[type])}>
      <Icon className="h-6 w-6" />
      {text}
    </button>
  );
};

export default CTAButton;
