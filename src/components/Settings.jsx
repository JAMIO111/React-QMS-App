import { useState } from "react";
import { Link, Outlet } from "react-router-dom";
import SettingMenuStructure from "../SettingMenuStructure";

const Settings = ({ onClose }) => {
  const [expandedItem, setExpandedItem] = useState(null);

  const toggleExpand = (index) => {
    setExpandedItem((prev) => (prev === index ? null : index));
  };

  return (
    <div className="flex flex-row p-5 gap-5 w-full h-full bg-primary-bg">
      <div className="flex flex-col w-80">
        <h1 className="text-primary-text text-2xl pb-8 border-b border-border-color mt-1 font-semibold">
          Settings
        </h1>
        {SettingMenuStructure.map((item, index) => (
          <Link to={item.path} key={index}>
            <div
              key={index}
              className="flex flex-col gap-1 mt-4"
              onClick={() => toggleExpand(index)}>
              <div className="flex flex-row cursor-pointer justify-between items-center px-4 py-2 gap-2 hover:bg-border-color rounded-xl">
                <h2 className="text-primary-text">{item.name}</h2>
                <span className="text-primary-text">
                  {expandedItem === index ? "-" : "+"}
                </span>
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
        ))}
      </div>
      <Outlet />
    </div>
  );
};

export default Settings;
