import React, { useState } from "react";
import Logo from "../assets/Logo-black-on-yellow.png";
import { TbLayoutSidebarRightExpand } from "react-icons/tb";
import { BsGear, BsQuestionCircle } from "react-icons/bs";
import NavItem from "./NavItem";
import Logout from "./Logout";
import { menuStructure } from "../MenuStructure";
import SubMenuItem from "./SubMenuItem";
import ThemeToggle from "./ThemeToggle";

const Navbar = () => {
  const [isMenuExpanded, setIsMenuExpanded] = useState(false);
  const [isSubMenuOpen, setIsSubMenuOpen] = useState(null);

  const toggleMenu = () => {
    setIsSubMenuOpen(null);
    setIsMenuExpanded((prev) => !prev);
  };

  const closeMenu = () => {
    setIsSubMenuOpen(null);
    setIsMenuExpanded(false);
  };

  const toggleSubMenu = (name) => {
    setIsSubMenuOpen((prev) => (prev === name ? null : name));
  };

  return (
    <div className="flex bg-secondary-bg">
      <nav
        className={`flex flex-col border-r min-w-fit border-border-color h-screen ${
          isMenuExpanded ? "w-68" : "w-14"
        }`}>
        <div
          className={`flex justify-between items-center py-3 mb-3 border-b-1 border-border-color ${
            isMenuExpanded ? "flex-row mx-3" : "flex-col gap-3"
          }`}>
          <div className="flex items-center justify-start gap-3">
            <img
              className="w-10 h-10 rounded-lg border-1"
              src={Logo}
              alt="Logo"
            />
            {isMenuExpanded && (
              <h1 className=" font-semibold text-3xl text-primary-text">
                JDigital
              </h1>
            )}
          </div>
          <button
            title={isMenuExpanded ? "Hide Menu" : "Expand Menu"}
            onClick={toggleMenu}
            className="cursor-pointer">
            <TbLayoutSidebarRightExpand
              className={`h-6 w-6 stroke-icon-color ml-3 hover:stroke-primary-text ${
                !isMenuExpanded && "rotate-180 mr-3"
              }`}
            />
          </button>
        </div>
        <div className="flex flex-col flex-1 overflow-y-auto justify-between">
          <ul className="gap-1 flex-1 flex flex-col">
            {menuStructure.map((item) => (
              <li key={item.name}>
                <NavItem
                  title={item.name}
                  label={item.name}
                  icon={item.icon}
                  path={item.path}
                  isExpanded={isMenuExpanded}
                  closeMenu={closeMenu}
                  hasSubMenu={
                    Array.isArray(item.subMenu) && item.subMenu.length > 0
                  }
                  onToggleSubMenu={() => toggleSubMenu(item.name)}
                  isSubMenuOpen={isSubMenuOpen}
                />
                {item.subMenu && isSubMenuOpen === item.name && (
                  <ul className="ml-4 flex flex-col">
                    {item.subMenu?.map((subItem, index) => (
                      <li key={subItem.name}>
                        <SubMenuItem
                          title={subItem.name}
                          label={subItem.name}
                          path={subItem.path}
                          isLast={index === item.subMenu?.length - 1}
                          closeMenu={closeMenu}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          <div className="border-t-1 border-border-color"></div>
          <ul className="gap-2 flex my-2 flex-col">
            <NavItem
              label="Settings"
              icon={BsGear}
              isExpanded={isMenuExpanded}
              path="/settings"
              onClick={() => {}}
            />
            <NavItem
              label="Help Centre"
              icon={BsQuestionCircle}
              isExpanded={isMenuExpanded}
              path="/help"
            />
            <div className="border-t-1 mx-3 border-border-color"></div>
            <div className="flex flex-col justify-between items-start gap-2 pt-2">
              <ThemeToggle menuExpanded={isMenuExpanded} />
              <Logout isExpanded={isMenuExpanded} />
            </div>
          </ul>
        </div>
      </nav>
    </div>
  );
};

export default Navbar;
