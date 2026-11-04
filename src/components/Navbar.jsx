import { useState } from "react";
import Logo from "../assets/dryden-logo-square.png";
import { CircleHelpIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, SettingsIcon } from "@/components/icons";
import NavItem from "./NavItem";
import Logout from "./Logout";
import { menuStructure } from "../MenuStructure";
import { useCanSee } from "../hooks/useQmsApi";
import SubMenuItem from "./SubMenuItem";
import ThemeToggle from "./ThemeToggle";

const Navbar = () => {
  const [isMenuExpanded, setIsMenuExpanded] = useState(false);
  const canSee = useCanSee();
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
        className={`flex flex-col border-r ${
          !isMenuExpanded ? "transition-all duration-500" : null
        } min-w-fit border-border-color h-screen ${
          isMenuExpanded ? "w-68" : "w-14"
        }`}>
        <div
          className={`flex justify-start items-center py-3 border-b-1 border-border-color ${
            isMenuExpanded ? "flex-row mx-3" : "flex-col gap-3"
          }`}>
          <div className="flex bg-primary-bg border border-primary-text rounded-xl p-0.5 items-center justify-start gap-3">
            <div className="flex justify-center items-center bg-white rounded-[10px] p-1">
              <img className="w-6 h-6" src={Logo} alt="Logo" />
            </div>
          </div>
          {isMenuExpanded && (
            <div className="flex flex-col justify-between items-start flex-1">
              <h1 className="ml-3 flex-1 text-sm text-primary-text">
                Dryden Services Ltd
              </h1>
              <p className="ml-3 flex-1 text-xs text-secondary-text">
                Business Portal
              </p>
            </div>
          )}
          <button
            title={isMenuExpanded ? "Hide Menu" : "Expand Menu"}
            onClick={toggleMenu}
            className="cursor-pointer">
            {isMenuExpanded ? (
              <PanelLeftCloseIcon className="h-6 w-6 text-icon-color hover:text-primary-text" />
            ) : (
              <PanelLeftOpenIcon className="h-6 w-6 text-icon-color hover:text-primary-text" />
            )}
          </button>
        </div>
        <div className="flex flex-col h-full overflow-y-auto justify-between">
          <ul className="gap-1 flex-1 flex flex-col pt-3">
            {menuStructure.filter((item) => canSee(item.permission)).map((item) => (
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
                          end={!!subItem.end}
                          isFirst={index === 0}
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
          <div className="border-t-1 mt-2 border-border-color"></div>
          <ul className="gap-2 flex my-2 flex-col">
            <NavItem
              label="Settings"
              icon={SettingsIcon}
              isExpanded={isMenuExpanded}
              path="/Settings"
              onClick={() => {}}
            />
            <NavItem
              label="Help Centre"
              icon={CircleHelpIcon}
              isExpanded={isMenuExpanded}
              path="/Help"
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
