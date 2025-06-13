import React from "react";
import useTheme from "../hooks/useTheme";
import { BsSun, BsMoonStars } from "react-icons/bs";

const ThemeToggle = ({ menuExpanded }) => {
  const [theme, setTheme] = useTheme();

  const handleToggle = () => {
    if (theme === "light") {
      setTheme("dark");
    } else {
      setTheme("light");
    }
  };

  const capitalized = theme.charAt(0).toUpperCase() + theme.slice(1);

  return (
    <button
      title={`Toggle ${theme === "light" ? "Dark" : "Light"} Mode`}
      className={`flex justify-between items-center rounded-full border-primary-bg border bg-primary-text cursor-pointer ${
        menuExpanded
          ? "flex-row w-32 mx-auto p-1"
          : "flex-col p-0.5 w-fit h-17 mx-auto"
      }`}
      onClick={handleToggle}>
      {theme === "light" && (
        <div
          className={`bg-white rounded-full ${menuExpanded ? "p-2" : "p-1.5"}`}>
          <BsSun />
        </div>
      )}
      {menuExpanded && (
        <span className="text-sm text-primary-bg mx-auto">
          {capitalized} Mode
        </span>
      )}
      {theme === "dark" && (
        <div
          className={`bg-black rounded-full mt-auto ${
            menuExpanded ? "p-2" : "p-1.5"
          }`}>
          <BsMoonStars className="fill-white" />
        </div>
      )}
    </button>
  );
};

export default ThemeToggle;
