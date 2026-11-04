import { useState } from "react";
import { ChevronDownIcon } from "@/components/icons";
import MenuCard from "../ui/MenuCard";

/** A MenuCard whose body opens and closes from the button in its header. */
const Accordion = ({ title, subtitle, children }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <MenuCard
      title={title}
      subtitle={subtitle}
      className="w-full"
      action={
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${title}`}
          onClick={() => setExpanded((prev) => !prev)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-secondary-text transition-colors hover:bg-border-color/50 cursor-pointer">
          <ChevronDownIcon className={`h-7 w-7 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
      }>
      {expanded && children}
    </MenuCard>
  );
};

export default Accordion;
