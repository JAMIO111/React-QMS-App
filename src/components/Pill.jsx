import React from "react";

const Pill = ({ icon, text }) => {
  return (
    <div className="flex w-fit gap-2 items-center bg-brand-secondary/30 text-white border border-brand-secondary rounded-full px-3 py-1">
      {icon && <span className="text-lg text-white">{icon}</span>}
      <span className="text-sm text-primary-text">{text}</span>
    </div>
  );
};

export default Pill;
