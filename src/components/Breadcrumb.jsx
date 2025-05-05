import React from "react";
import { useLocation, Link } from "react-router-dom";
import { BiHome } from "react-icons/bi";
import { IoFolderOpenOutline } from "react-icons/io5";
import { RxDashboard } from "react-icons/rx";
import { PiWarning } from "react-icons/pi";
import {
  BsFolder,
  BsGear,
  BsBoxes,
  BsQuestionCircle,
  BsPeople,
} from "react-icons/bs";
import { LiaFileInvoiceDollarSolid } from "react-icons/lia";

const iconMap = {
  Dashboard: <BiHome />,
  "Non-Conformance": <PiWarning />,
  Inventory: <BsBoxes />,
  "Human-Resources": <BsPeople />,
  Settings: <BsGear />,
  // default fallback if not found
};

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean);
}

const Breadcrumb = () => {
  const location = useLocation();
  const segments = splitPath(location.pathname);

  return (
    <nav className="flex items-center gap-1 text-sm text-secondary-text font-semibold">
      <BiHome />
      <Link to="/" className="hover:underline">
        Home
      </Link>
      {segments.map((segment, index) => {
        const path = "/" + segments.slice(0, index + 1).join("/");
        return (
          <React.Fragment key={segment}>
            <span className="mx-1">/</span>
            {iconMap[segment] || <IoFolderOpenOutline />}
            <Link to={path} className="hover:underline capitalize">
              {decodeURIComponent(segment)}
            </Link>
          </React.Fragment>
        );
      })}
    </nav>
  );
};

export default Breadcrumb;
