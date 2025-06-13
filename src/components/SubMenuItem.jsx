import { NavLink } from "react-router-dom";

const SubMenuItem = ({ closeMenu, label, isLast, isFirst, path }) => {
  return (
    <div
      className={`${
        isLast ? "mb-2" : isFirst ? "mt-2" : ""
      } flex flex-row items-center justify-start rounded-lg w-full h-8 pr-3`}>
      <NavLink
        to={path}
        onClick={closeMenu}
        className={({ isActive }) =>
          `flex flex-row items-center justify-start w-full h-8 pr-3 pl-4 ${
            isActive ? "text-cta-color" : "text-primary-text"
          }`
        }>
        {({ isActive }) => (
          <>
            <div
              className={`${
                isActive ? "bg-cta-color" : "bg-border-color"
              } self-start h-full w-0.5`}
            />
            <div
              className={`${
                isActive &&
                "bg-cta-color/20 hover:bg-cta-color/15 font-semibold"
              } pl-6 h-8 text-sm w-full flex items-center hover:bg-cta-color/10 rounded-r-lg`}>
              {label}
            </div>
          </>
        )}
      </NavLink>
    </div>
  );
};

export default SubMenuItem;
