import React from "react";

const IconButton = ({ selected, icon, callback, title }) => {
  return (
    <button
      title={title}
      onClick={callback}
      className={`border border-gray-300 w-fit box-border h-8 px-2 gap-1 flex justify-center rounded-lg items-center cursor-pointer ${
        selected ? "ring-2 ring-blue-600 border-transparent" : ""
      }`}>
      {icon}
      <p>{title}</p>
    </button>
  );
};

export default IconButton;
