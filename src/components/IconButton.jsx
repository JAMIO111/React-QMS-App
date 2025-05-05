import React from "react";
import clsx from "clsx";

const IconButton = ({ selected, icon, callback, title, color }) => {
  const baseClass =
    "border hover:border-border-dark-color active:scale-97 border-border-color w-fit box-border h-8 px-2 gap-1 flex justify-center rounded-lg items-center cursor-pointer";

  const selectedClass = selected
    ? `bg-${color}-100 ring-${color}-600 ring-2 border-transparent`
    : "text-primary-text";

  return (
    <button
      title={title}
      onClick={callback}
      className={clsx(baseClass, selectedClass)}>
      {icon}
      <p>{title}</p>
    </button>
  );
};

export default IconButton;
