import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import SettingMenuStructure from "../../SettingMenuStructure";
import { useCanSee } from "../../hooks/useQmsApi";
import { DatabaseIcon } from "@/components/icons";

const Settings = () => {
  const { pathname } = useLocation();
  const canSee = useCanSee();
  const [expandedItem, setExpandedItem] = useState(null);

  const toggleExpand = (index) => {
    setExpandedItem((prev) => (prev === index ? null : index));
  };

  return (
    <div className="flex flex-row pr-0 w-full grow bg-primary-bg overflow-y-hidden">
      <div className="flex flex-col border-r border-border-color w-65 min-w-65">
        <h1 className="text-primary-text pl-5 pb-2 border-b border-border-color mt-2">
          Settings
        </h1>
        {SettingMenuStructure.filter((item) => canSee(item.permission)).map(
          (item, index) => {
            const match = pathname
              .toLowerCase()
              .startsWith(`/settings/${item.path.toLowerCase()}`);
            return (
              <Link to={item.path} key={index}>
                <div
                  key={index}
                  className={`${
                    match && "bg-cta-color"
                  } flex flex-col gap-1 mx-2 mt-2 rounded-xl`}
                  onClick={() => toggleExpand(index)}>
                  <div className="flex flex-row cursor-pointer justify-between items-center px-3 py-1 gap-2 hover:bg-border-color/50 rounded-xl">
                    <div className="flex flex-row items-center justify-start gap-2">
                      {item.icon ? (
                        <item.icon
                          className={`${
                            match ? "text-white" : "text-primary-text"
                          } h-4 w-4 `}
                        />
                      ) : (
                        <DatabaseIcon
                          className={`${
                            match ? "text-white" : "text-primary-text"
                          } h-4 w-4 `}
                        />
                      )}
                      <h2
                        className={`${
                          match
                            ? "text-white font-semibold"
                            : "text-primary-text"
                        } text-left`}>
                        {item.name}
                      </h2>
                    </div>
                    {item.subMenu.length > 0 && (
                      <div
                        className={`${
                          expandedItem === index ? "rotate-180" : ""
                        } transition-transform duration-200`}>
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-5 w-5 text-secondary-text"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 9l-7 7-7-7"
                          />
                        </svg>
                      </div>
                    )}
                  </div>
                  {expandedItem === index && item.subMenu.length > 0 && (
                    <div className="flex flex-col gap-2 pl-4">
                      {item.subMenu.map((subItem, subIndex) => (
                        <div key={subIndex} className="text-secondary-text">
                          {subItem}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Link>
            );
          },
        )}
      </div>
      <div className="flex-grow flex flex-col overflow-y-scroll">
        <Outlet />
      </div>
    </div>
  );
};

export default Settings;
