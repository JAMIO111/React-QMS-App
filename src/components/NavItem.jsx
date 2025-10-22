import { NavLink, useMatch } from "react-router-dom";
import { HiOutlineChevronDown } from "react-icons/hi";

const NavItem = ({
  label,
  icon: Icon,
  path,
  isExpanded,
  hasSubMenu,
  onToggleSubMenu,
  isSubMenuOpen,
  closeMenu,
}) => {
  const match = useMatch(path);

  return (
    <div className="nav-item flex pr-3 items-center ">
      <div
        className={`${
          match ? "bg-cta-color" : "bg-transparent"
        } w-1 h-9 rounded-r-md`}></div>
      <NavLink
        title={label}
        className={({ isActive }) =>
          `flex gap-3 w-full rounded-lg ml-2 p-2 h-9 items-center border border-transparent
  ${
    isActive
      ? "text-white border-cta-color hover:bg-cta-color/80 bg-cta-color/50"
      : "text-primary-text hover:border-cta-color/20 hover:bg-cta-color/10"
  }`
        }
        onClick={closeMenu}
        to={path}>
        {Icon && <Icon className="h-6 w-6" />}
        {isExpanded && <span className="text-sm flex-1">{label}</span>}
        {isExpanded && hasSubMenu && (
          <HiOutlineChevronDown
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleSubMenu();
            }}
            className={`hover:bg-cta-color/20 rounded p-1.5 h-6 w-6 transition-transform ${
              isSubMenuOpen === label ? "rotate-180" : ""
            }`}
          />
        )}
      </NavLink>
    </div>
  );
};

export default NavItem;
