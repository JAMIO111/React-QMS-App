import { useState } from "react";
import FortressMark from "../assets/fortress-qms.png";
import {
  CircleHelpIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SettingsIcon,
} from "@/components/icons";
import NavItem from "./NavItem";
import { menuStructure } from "../MenuStructure";
import { useCanSee, useOrganisationLogo } from "../hooks/useQmsApi";
import { useMyAlertCount } from "../hooks/useDocumentation";
import { useMyCapaActions } from "../hooks/useCapa";
import { useModuleAccess } from "../hooks/useSubscription";
import { useProductionSettings } from "../hooks/useProduction";
import { subMenuVisible } from "../lib/production";
import { useOrganisation } from "../contexts/OrganisationProvider";
import SubMenuItem from "./SubMenuItem";

const Navbar = () => {
  const [isMenuExpanded, setIsMenuExpanded] = useState(false);
  const canSee = useCanSee();
  const productionSettings = useProductionSettings();
  const myAlerts = useMyAlertCount({ enabled: canSee("documentation.read") });
  const myActions = useMyCapaActions("open", { enabled: canSee("capa.read") });
  const badges = {
    "my-alerts": myAlerts.data?.unacknowledged ?? 0,
    "my-actions": myActions.data?.openCount ?? 0,
  };
  const hasModule = useModuleAccess();
  const { organisation } = useOrganisation();
  const { data: logoUrl } = useOrganisationLogo();
  const orgName = organisation?.name ?? "";
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
        className={`flex h-screen flex-col overflow-hidden whitespace-nowrap border-r border-border-color transition-[width] duration-300 ease-in-out motion-reduce:transition-none ${
          isMenuExpanded ? "w-68" : "w-14"
        }`}>
        <div
          className={`flex justify-start items-center py-3 border-b-1 border-border-color ${
            isMenuExpanded ? "flex-row mx-3" : "flex-col gap-3"
          }`}>
          {/* The organisation's own logo; Fortress QMS's mark until one is uploaded. */}
          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-border-color bg-white">
            <img
              className="h-full w-full object-contain"
              src={logoUrl || FortressMark}
              alt={logoUrl ? `${orgName} logo` : "Fortress QMS"}
            />
          </div>
          {isMenuExpanded && (
            <div className="ml-3 flex min-w-0 flex-1 flex-col justify-between items-start animate-in fade-in duration-300 motion-reduce:animate-none">
              <h1
                className="w-full truncate text-xs font-semibold text-primary-text"
                title={orgName}>
                {orgName || "Fortress QMS"}
              </h1>
              <p className="text-xs text-secondary-text">Fortress QMS</p>
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
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Only the modules scroll; the scrollbar is hidden so it never narrows the menu. */}
          <ul className="no-scrollbar flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pt-3">
            {menuStructure
              .filter(
                (item) => canSee(item.permission) && hasModule(item.module),
              )
              .map((item) => (
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
                    badge={badges[item.badge] ?? 0}
                  />
                  {item.subMenu && isSubMenuOpen === item.name && (
                    <ul className="ml-4 flex flex-col animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none">
                      {item.subMenu
                        ?.filter((subItem) => subMenuVisible(subItem, canSee, productionSettings))
                        .map((subItem, index, visible) => (
                          <li key={subItem.name}>
                            <SubMenuItem
                              title={subItem.name}
                              label={subItem.name}
                              path={subItem.path}
                              end={!!subItem.end}
                              isFirst={index === 0}
                              isLast={index === visible.length - 1}
                              closeMenu={closeMenu}
                              badge={badges[subItem.badge] ?? 0}
                            />
                          </li>
                        ))}
                    </ul>
                  )}
                </li>
              ))}
          </ul>
          <div className="mt-2 shrink-0 border-t-1 border-border-color"></div>
          <ul className="my-2 flex shrink-0 flex-col gap-2">
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
          </ul>
        </div>
      </nav>
    </div>
  );
};

export default Navbar;
