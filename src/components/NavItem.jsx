import { NavLink, useMatch } from "react-router-dom";
import { ChevronDownIcon } from "@/components/icons";

const NavItem = ({
  label,
  icon: Icon,
  path,
  isExpanded,
  hasSubMenu,
  onToggleSubMenu,
  isSubMenuOpen,
  closeMenu,
  badge = 0,
}) => {
  const match = useMatch(path);

  return (
    <div className="nav-item flex pr-3 items-center ">
      <div
        className={`${
          match ? "bg-cta-color" : "bg-transparent"
        } w-1 rounded-r-md`}></div>
      <NavLink
        title={label}
        className={({ isActive }) =>
          `flex gap-3 w-full rounded-lg ml-2 p-1.5 items-center border border-transparent
  ${
    isActive
      ? "text-white border-cta-color hover:bg-cta-color/80 bg-cta-color/50"
      : "text-primary-text hover:border-cta-color/20 hover:bg-cta-color/10"
  }`
        }
        onClick={closeMenu}
        to={path}>
        {Icon && (
          <span className="relative">
            <Icon className="h-5 w-5" />
            {badge > 0 && !isExpanded && (
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-error-color"
              />
            )}
          </span>
        )}
        {isExpanded && (
          <span className="text-sm flex-1 animate-in fade-in duration-300 motion-reduce:animate-none">
            {label}
          </span>
        )}
        {isExpanded && badge > 0 && (
          <span
            aria-label={`${badge} need your attention`}
            className="rounded-full bg-error-color px-1.5 text-xs font-medium text-white">
            {badge}
          </span>
        )}
        {isExpanded && hasSubMenu && (
          <ChevronDownIcon
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleSubMenu();
            }}
            className={`hover:bg-cta-color/20 rounded p-1.5 h-6 w-6 shrink-0 transition-transform duration-200 ${
              isSubMenuOpen === label ? "rotate-180" : ""
            }`}
          />
        )}
      </NavLink>
    </div>
  );
};

export default NavItem;
