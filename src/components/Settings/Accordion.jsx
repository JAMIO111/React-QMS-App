import { useState } from "react";
import { TbChevronDown } from "react-icons/tb";

const Accordion = ({ title, subtitle, children }) => {
  const [expanded, setExpanded] = useState(false);
  const iconClass = expanded ? "rotate-180" : "";
  return (
    <div className="flex flex-col grow-1 w-full p-5 rounded-2xl bg-secondary-bg border border-border-color">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-primary-text text-xl font-semibold">{title}</h2>
          <h3 className="text-secondary-text text-sm">{subtitle}</h3>
        </div>
        <button
          onClick={() => setExpanded((prev) => !prev)}
          className={`flex items-center justify-center w-10 h-10 rounded-lg text-secondary-text hover:bg-border-color/50 transition-colors cursor-pointer`}>
          <TbChevronDown
            className={`w-9 h-9 transition-transform ${iconClass}`}
          />
        </button>
      </div>
      {expanded && <div className="mt-4">{children}</div>}
    </div>
  );
};

export default Accordion;
