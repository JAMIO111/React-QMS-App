import React from "react";
import { useLocation, Link } from "react-router-dom";
import { BiHome } from "react-icons/bi";
import { IoFolderOpenOutline } from "react-icons/io5";
import { PiWarning } from "react-icons/pi";
import { BsBoxes, BsGear, BsPeople } from "react-icons/bs";

const iconMap = {
  Dashboard: <BiHome />,
  "Non-Conformance": <PiWarning />,
  Inventory: <BsBoxes />,
  "Human-Resources": <BsPeople />,
  Settings: <BsGear />,
};

// Utility: convert "non-conformance" → "Non Conformance"
function formatSegment(segment) {
  return segment
    .replace(/-/g, " ")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean);
}

const Breadcrumb = () => {
  const location = useLocation();
  const segments = splitPath(location.pathname);

  return (
    <nav className="flex items-center gap-1 text-sm text-secondary-text font-semibold">
      <BiHome />
      <Link to="/Dashboard" className="hover:underline">
        Home
      </Link>
      {segments.map((segment, index) => {
        const path = "/" + segments.slice(0, index + 1).join("/");
        return (
          <React.Fragment key={segment}>
            <span className="mx-1">/</span>
            {iconMap[segment] || <IoFolderOpenOutline />}
            <Link to={path} className="hover:underline capitalize">
              {formatSegment(decodeURIComponent(segment))}
            </Link>
          </React.Fragment>
        );
      })}
    </nav>
  );
};

export default Breadcrumb;
