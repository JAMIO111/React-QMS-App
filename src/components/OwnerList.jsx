import { useState } from "react";
import { MdPeopleOutline } from "react-icons/md";
import { AiOutlineUserAdd } from "react-icons/ai";
import CTAButton from "./CTAButton";
import { useNavigate } from "react-router-dom";

const OwnerList = ({ onSelectOwner, selectedOwner, owners }) => {
  const navigate = useNavigate();

  return (
    <div className="bg-secondary-bg w-1/4 rounded-2xl shadow-m flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex flex-row gap-3 items-center px-4 py-4 border-b border-border-color">
        <MdPeopleOutline className="w-7 h-7 text-primary-text" />
        <h2 className="text-xl text-primary-text font-semibold">Owner List</h2>
      </div>

      {/* Scrollable List */}
      <div className="flex-1 p-3 overflow-y-auto">
        <ul>
          {owners.length === 0 ? (
            <div className="p-3 text-center ">
              <div className="bg-text-input-color text-secondary-text text-sm rounded-lg p-4">
                No results found
              </div>
            </div>
          ) : (
            owners
              ?.sort((a, b) => a.first_name.localeCompare(b.first_name))
              .map((owner) => (
                <li
                  key={owner.id}
                  className={`flex items-center p-3 cursor-pointer ${
                    selectedOwner?.id === owner.id
                      ? "rounded-2xl shadow-s border-border-color bg-primary-bg"
                      : ""
                  }`}
                  onClick={() => onSelectOwner(owner)}
                  onDoubleClick={() =>
                    navigate(`/Client-Management/Owners/${owner.id}`)
                  }>
                  {/* Owner Image */}
                  <div className="relative mr-4">
                    {owner.avatar ? (
                      <img
                        src={owner.avatar}
                        alt={owner.first_name}
                        className="w-12 h-12 rounded-lg border border-border-color object-cover"
                      />
                    ) : (
                      <div
                        className={`${
                          selectedOwner?.id === owner.id
                            ? "bg-tertiary-bg"
                            : "bg-primary-bg"
                        } w-12 h-12 flex items-center justify-center rounded-lg border border-border-color`}>
                        <span className="text-secondary-text">
                          {owner.first_name.charAt(0)}
                        </span>
                        <span className="text-secondary-text">
                          {owner.surname.charAt(0)}
                        </span>
                      </div>
                    )}
                    <div
                      className={`absolute rounded-full w-3 h-3 ${
                        owner.is_active ? "bg-green-500" : "bg-red-500"
                      } -bottom-0.5 -right-0.5`}></div>
                  </div>

                  {/* Owner Details */}
                  <div>
                    <p className={`text-primary-text font-semibold`}>
                      {owner.first_name} {owner.surname}
                    </p>
                    <p
                      className={` text-sm ${
                        selectedOwner?.id === owner.id
                          ? "text-secondary-bg"
                          : "text-secondary-text"
                      }`}>
                      {owner.role}
                    </p>
                  </div>
                </li>
              ))
          )}
        </ul>
      </div>
      <div className="p-3 border-t border-border-color">
        <CTAButton
          width="w-full"
          type="main"
          text="Add New Owner"
          icon={AiOutlineUserAdd}
          callbackFn={() => navigate("/Client-Management/Owners/New-Owner")}
        />
      </div>
    </div>
  );
};

export default OwnerList;
