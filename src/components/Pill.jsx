import React from "react";

const Pill = ({ icon, text, color = "orange" }) => {
  let colorClass;
  switch (color) {
    case "red":
      colorClass = "bg-red-500/20 border-red-500 border";
      break;
    case "green":
      colorClass = "bg-green-500/20 border-green-500 border";
      break;
    case "blue":
      colorClass = "bg-blue-500/20 border-blue-500 border";
      break;
    case "orange":
      colorClass = "bg-orange-500/20 border-orange-500 border";
      break;
    case "purple":
      colorClass = "bg-purple-500/20 border-purple-500 border";
      break;
    default:
      colorClass = "bg-brand-secondary/30 text-white border-brand-secondary";
      break;
  }

  return (
    <div
      className={`flex w-fit gap-2 items-center ${colorClass} text-white border rounded-full px-3 py-1`}>
      {icon && <span className="text-lg text-white">{icon}</span>}
      <span className="text-sm text-primary-text">{text}</span>
    </div>
  );
};

export default Pill;
