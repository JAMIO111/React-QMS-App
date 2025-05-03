import React, { useState } from "react";
import { BsGear } from "react-icons/bs";

const Settings = ({ onClose }) => {
  const [settingsMenuExpanded, setSettingsMenuExpanded] = useState(false);
  return (
    <div className="p-5 w-full h-full">
      <div className="flex flex-row border rounded-2xl border-gray-200 shadow-lg shadow-gray-300 h-full w-full">
        <div className="flex flex-1/3 flex-col gap-2 border-r border-gray-300 p-3">
          <h1 className="pl-1 text-2xl font-semibold">Settings</h1>
          <button className="w-full h-10 p-2 border rounded-lg border-gray-300 flex items-center justify-between">
            <div className="flex flex-row gap-3 items-center">
              <BsGear />
              <h2>General</h2>
            </div>
          </button>
          <div className="flex flex-col gap-3 p-5"></div>
        </div>
        <div className="flex flex-2/3 flex-col"></div>
      </div>
    </div>
  );
};

export default Settings;
