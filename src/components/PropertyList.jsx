import { useState } from "react";
import { MdPeopleOutline } from "react-icons/md";
import { BsHouseAdd, BsHouses } from "react-icons/bs";
import CTAButton from "./CTAButton";
import { useNavigate } from "react-router-dom";

const PropertyList = ({ onSelectProperty, selectedProperty, properties }) => {
  const navigate = useNavigate();

  const handleNewEntry = () => {
    navigate(`/Client-Management/Properties/New-Property`);
  };

  return (
    <div className="bg-secondary-bg w-1/2 rounded-2xl shadow-m flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex flex-row gap-3 items-center px-4 py-4 border-b border-border-color">
        <BsHouses className="w-7 h-7 text-primary-text" />
        <h2 className="text-xl flex-1 text-primary-text font-semibold">
          Property List
        </h2>
        <CTAButton
          callbackFn={handleNewEntry}
          type="main"
          text="Add New Property"
          icon={BsHouseAdd}
        />
      </div>

      {/* Scrollable List */}
      <div className="flex-1 overflow-y-auto">
        <ul>
          {properties.map((property) => (
            <li
              key={property.id}
              className={`flex border-b pr-5 border-border-color items-center cursor-pointer ${
                selectedProperty?.id === property.id
                  ? "bg-brand-primary/20"
                  : ""
              }`}
              onClick={() => onSelectProperty(property)}>
              {/* Property Image */}
              {property.avatar ? (
                <img
                  src={property.avatar}
                  alt={property?.name}
                  className="aspect-video h-28 border-r border-border-color object-cover mr-4"
                />
              ) : (
                <div
                  className={`${
                    selectedProperty?.id === property.id
                      ? "bg-primary-bg"
                      : "bg-primary-bg"
                  } aspect-video h-28 flex items-center justify-center border-r border-border-color mr-4`}>
                  <span className="text-secondary-text">No Image</span>
                </div>
              )}

              {/* Property Details */}
              <div>
                <p className={`text-primary-text font-semibold text-lg`}>
                  {property.name}
                </p>
                <p className={`text-sm text-secondary-text`}>
                  {[
                    property?.line_1,
                    property?.line_2,
                    property?.town,
                    property?.county,
                    property?.postcode,
                  ]
                    .filter(Boolean) // removes null, undefined, and empty strings
                    .join(", ")}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default PropertyList;
