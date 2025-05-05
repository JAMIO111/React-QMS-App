import React from "react";

const CTAButton = ({ text, icon: Icon, callbackFn }) => {
  return (
    <button
      onClick={callbackFn}
      className="flex flex-row gap-1 py-1 px-2 text-white items-center justify-center bg-cta-color rounded-lg active:scale-97 transition-transform duration-200 ease-in-out cursor-pointer">
      <Icon className="h-6 w-6" />
      {text}
    </button>
  );
};

export default CTAButton;
