import React, { useState } from "react";
import Logo from "../assets/Logo-black-on-yellow.png";
import {
  TbLayoutSidebarRightExpand,
  TbLayoutSidebarLeftExpand,
} from "react-icons/tb";
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
import NavItem from "./NavItem";
import Logout from "./Logout";

const Navbar = () => {
  const [isMenuExpanded, setIsMenuExpanded] = useState(false);

  const toggleMenu = () => {
    setIsMenuExpanded((prev) => !prev);
  };

  return (
    <div className="flex">
      <nav
        className={`flex flex-col border-r-1 min-w-fit border-gray-200 h-dvh ${
          isMenuExpanded ? "w-66" : "w-14"
        }`}>
        <div
          className={`flex justify-between items-center py-3 mb-3 border-b-1 border-gray-200 ${
            isMenuExpanded ? "flex-row mx-3" : "flex-col gap-3"
          }`}>
          <div className="flex items-center justify-start gap-3">
            <img
              className="w-10 h-10 rounded-lg border-1"
              src={Logo}
              alt="Logo"
            />
            {isMenuExpanded && (
              <h1 className=" font-semibold text-3xl text-gray-800">
                JDigital
              </h1>
            )}
          </div>
          <button
            title={isMenuExpanded ? "Hide Menu" : "Expand Menu"}
            onClick={toggleMenu}
            className="cursor-pointer">
            {isMenuExpanded ? (
              <TbLayoutSidebarRightExpand className="h-6 w-6 stroke-gray-600 ml-3 hover:stroke-black" />
            ) : (
              <TbLayoutSidebarLeftExpand className="h-6 w-6  stroke-gray-600 hover:stroke-black" />
            )}
          </button>
        </div>
        <div className="flex flex-col flex-1 justify-between">
          <ul className="gap-1 flex-1 flex flex-col">
            <NavItem
              label="Dashboard"
              icon={RxDashboard}
              isExpanded={isMenuExpanded}
              setIsMenuExpanded={setIsMenuExpanded}
            />
            <NavItem
              label="Non-Conformance"
              icon={PiWarning}
              isExpanded={isMenuExpanded}
              setIsMenuExpanded={setIsMenuExpanded}
            />
            <NavItem
              label="Projects"
              icon={BsFolder}
              isExpanded={isMenuExpanded}
              setIsMenuExpanded={setIsMenuExpanded}
            />
            <NavItem
              label="Purchase Orders"
              icon={LiaFileInvoiceDollarSolid}
              isExpanded={isMenuExpanded}
              setIsMenuExpanded={setIsMenuExpanded}
            />
            <NavItem
              label="Inventory"
              icon={BsBoxes}
              isExpanded={isMenuExpanded}
              setIsMenuExpanded={setIsMenuExpanded}
            />
            <NavItem
              label="Human Resources"
              icon={BsPeople}
              isExpanded={isMenuExpanded}
              setIsMenuExpanded={setIsMenuExpanded}
            />
          </ul>
          <div className="border-t-1 border-gray-200"></div>
          <ul className="gap-2 flex my-2 flex-col">
            <NavItem
              label="Settings"
              icon={BsGear}
              isExpanded={isMenuExpanded}
              onClick={() => setSettingsModal(true)}
            />
            <NavItem
              label="Help Centre"
              icon={BsQuestionCircle}
              isExpanded={isMenuExpanded}
            />
            <div className="border-t-1 mx-3 border-gray-200"></div>
            <Logout isExpanded={isMenuExpanded} />
          </ul>
        </div>
      </nav>
    </div>
  );
};

export default Navbar;
