import { BsPencil, BsFillPersonVcardFill } from "react-icons/bs";
import CTAButton from "./CTAButton";
import { HiOutlinePhone } from "react-icons/hi2";
import { TfiEmail } from "react-icons/tfi";
import PropertyNavigation from "./ui/PropertyNavigation";
import { IoLocationOutline, IoText, IoPerson } from "react-icons/io5";
import { usePropertiesByOwner } from "@/hooks/usePropertiesByOwner";
import { useEffect, useState } from "react";
import Pill from "@components/Pill";
import { FaBed, FaBath } from "react-icons/fa6";
import { useNavigate } from "react-router-dom";
import { BsHouseAdd } from "react-icons/bs";

const OwnerDetails = ({ owner }) => {
  const navigate = useNavigate();
  const { data: properties, isLoading } = usePropertiesByOwner(owner?.id);
  console.log("Properties:", properties);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedProperty, setSelectedProperty] = useState(null);

  console.log("selected property:", selectedProperty);

  // Set default property when data loads
  useEffect(() => {
    if (properties?.length > 0) {
      setCurrentIndex(0);
      setSelectedProperty(properties[0]);
    }
  }, [properties]);

  // Update selectedProperty whenever currentIndex changes
  useEffect(() => {
    if (properties && properties.length > 0) {
      setSelectedProperty(properties[currentIndex]);
    }
  }, [currentIndex, properties]);

  const handlePrev = () => {
    setCurrentIndex((prev) => (prev === 0 ? properties.length - 1 : prev - 1));
  };

  const handleNext = () => {
    setCurrentIndex((prev) => (prev === properties.length - 1 ? 0 : prev + 1));
  };

  return (
    <div className="bg-secondary-bg flex-1 h-full flex flex-col rounded-2xl shadow-m">
      {!owner ? (
        <div className="w-full h-full flex items-center justify-center">
          <div className="gap-5 flex flex-col text-primary-text text-xl text-center border border-border-color bg-primary-bg p-10 rounded-xl">
            <p>No owner selected</p>
            <p>Select an owner to view details</p>
          </div>
        </div>
      ) : (
        <>
          {/* Header */}
          <div className="flex h-16 flex-row gap-3 items-center px-4 py-3 border-b border-border-color shrink-0">
            <BsFillPersonVcardFill className="w-7 h-7 text-primary-text" />
            <h2 className="text-xl flex-1 text-primary-text font-semibold">
              Owner Details
            </h2>
            <CTAButton
              type="main"
              icon={BsPencil}
              text="Edit Owner Details"
              callbackFn={() => {
                navigate(`/Client-Management/Owners/${owner?.id}`);
              }}
            />
          </div>

          {/* Details */}
          <div className="flex flex-1 flex-row gap-3 overflow-hidden p-3">
            {/* Left Column */}
            <div className="flex flex-col gap-3 w-[60%] h-full">
              <div className="flex flex-row border border-brand-primary/60 p-3 rounded-2xl bg-brand-primary/30 items-center">
                {/* Avatar */}
                <div className="relative mr-4">
                  {owner.avatar ? (
                    <img
                      src={owner.avatar}
                      alt={owner.first_name}
                      className="w-28 h-28 rounded-2xl border border-border-color object-cover"
                    />
                  ) : (
                    <div className="min-w-28 h-28 rounded-2xl border border-border-color object-cover bg-primary-bg flex items-center justify-center">
                      <span className="text-3xl text-secondary-text">
                        {owner.first_name.charAt(0)}
                      </span>
                      <span className="text-3xl text-secondary-text">
                        {owner.surname.charAt(0)}
                      </span>
                    </div>
                  )}
                  <div className="absolute p-0.5 rounded-full bg-primary-bg -top-1 -right-1">
                    <div
                      className={`rounded-full w-4 h-4 ${
                        owner.is_active ? "bg-green-500" : "bg-red-500"
                      } `}></div>
                  </div>
                </div>

                {/* Info */}
                <div className="ml-2 flex flex-col gap-2 h-full justify-around min-w-0">
                  <div className="flex items-center gap-3">
                    <BsFillPersonVcardFill className="text-primary-text w-6 h-6 shrink-0" />
                    <p
                      className="text-xl truncate min-w-0 text-primary-text font-semibold text-left"
                      title={`${owner?.first_name} ${owner?.surname}`}>
                      {owner?.first_name} {owner?.surname}
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <HiOutlinePhone className="text-primary-text w-6 h-6 shrink-0" />
                    <p
                      className="truncate min-w-0 text-lg text-primary-text font-medium text-left"
                      title={owner?.primary_phone}>
                      {owner?.primary_phone || "No Phone No."}
                    </p>
                  </div>

                  {/* Email */}
                  <div className="flex items-center gap-3 max-w-full">
                    <TfiEmail className="text-primary-text w-5 h-5 shrink-0" />
                    <p
                      className="ml-1 truncate text-sm text-primary-text text-left min-w-0"
                      title={owner?.primary_email}>
                      {owner?.primary_email || "No Email"}
                    </p>
                  </div>
                </div>
              </div>

              {/* Full Info */}
              <div className="border flex-1 py-3 gap-3 flex flex-col border-border-color rounded-2xl bg-tertiary-bg overflow-hidden">
                <div className="px-5 flex flex-row justify-between items-center gap-5">
                  <div className="flex flex-row items-center gap-2">
                    <IoText className="text-primary-text w-4 h-4 shrink-0" />
                    <h3 className="font-semibold text-primary-text">
                      First Name
                    </h3>
                  </div>
                  <p className="text-sm text-primary-text">
                    {owner?.first_name}
                  </p>
                </div>
                <div className="px-5 flex flex-row justify-between items-center gap-5">
                  <div className="flex flex-row items-center gap-2">
                    <IoText className="text-primary-text w-4 h-4 shrink-0" />
                    <h3 className="font-semibold text-primary-text">Surname</h3>
                  </div>
                  <p className="text-sm text-primary-text">{owner?.surname}</p>
                </div>
                <div className="px-5 flex flex-row justify-between items-center gap-5">
                  <div className="flex flex-row items-center gap-2">
                    <HiOutlinePhone className="text-primary-text w-4 h-4 shrink-0" />
                    <h3 className="font-semibold text-primary-text">
                      Primary Phone
                    </h3>
                  </div>
                  <p className="text-sm text-primary-text">
                    {owner?.primary_phone || "No Phone No."}
                  </p>
                </div>
                {owner?.secondary_phone && (
                  <div className="px-5 flex flex-row justify-between items-center gap-5">
                    <div className="flex flex-row items-center gap-2">
                      <HiOutlinePhone className="text-primary-text w-4 h-4 shrink-0" />
                      <h3 className="font-semibold text-primary-text">
                        Secondary Phone
                      </h3>
                    </div>
                    <p className="text-sm text-primary-text">
                      {owner?.secondary_phone}
                    </p>
                  </div>
                )}
                <div className="px-5 flex flex-row justify-between items-center gap-5">
                  <div className="flex flex-row items-center gap-2">
                    <TfiEmail className="text-primary-text w-4 h-4 shrink-0" />
                    <h3 className="font-semibold text-primary-text">
                      Primary Email
                    </h3>
                  </div>
                  <p className="text-sm text-primary-text">
                    {owner?.primary_email || "No Email"}
                  </p>
                </div>
                {owner?.secondary_email && (
                  <div className="px-5 flex flex-row justify-between items-center gap-5">
                    <div className="flex flex-row items-center gap-2">
                      <TfiEmail className="text-primary-text w-4 h-4 shrink-0" />
                      <h3 className="font-semibold text-primary-text">
                        Secondary Email
                      </h3>
                    </div>
                    <p className="text-sm text-primary-text">
                      {owner?.secondary_email}
                    </p>
                  </div>
                )}
                <div className="px-5 flex flex-row justify-between items-center gap-5">
                  <div className="flex flex-row items-center gap-2">
                    <IoLocationOutline className="text-primary-text w-4 h-4 shrink-0" />
                    <h3 className="font-semibold text-primary-text">
                      Location
                    </h3>
                  </div>
                  <p className="text-sm text-primary-text">
                    {owner?.location || "No Location"}
                  </p>
                </div>
              </div>
            </div>

            {/* Right Column */}
            <div className="flex flex-col w-[40%] h-full overflow-y-auto gap-3">
              {properties?.length > 0 ? (
                <div className="flex h-200 flex-col bg-tertiary-bg rounded-2xl border border-border-color overflow-hidden">
                  <img
                    src="/mansion-1.jpg"
                    alt={`${owner?.first_name} ${owner?.surname}`}
                    className="w-full aspect-video object-cover"
                  />
                  <div className="p-3">
                    <h3 className="text-lg mb-2 font-semibold text-primary-text">
                      {selectedProperty?.property?.name}
                    </h3>
                    <div className="flex flex-row mb-3 items-start gap-2">
                      <IoLocationOutline className="text-primary-text w-4 h-4 shrink-0" />
                      <p className="text-sm text-primary-text">
                        {[
                          selectedProperty?.property?.line_1,
                          selectedProperty?.property?.line_2,
                          selectedProperty?.property?.town,
                          selectedProperty?.property?.county,
                          selectedProperty?.property?.postcode,
                        ]
                          .filter(Boolean) // removes null, undefined, and empty strings
                          .join(", ")}
                      </p>
                    </div>
                    <div className="flex flex-row gap-2 mb-2 flex-wrap">
                      <Pill
                        icon={
                          <FaBed className="text-primary-text w-4 h-4 shrink-0" />
                        }
                        text={`${selectedProperty?.property?.bedrooms} Bed`}
                      />
                      <Pill
                        icon={
                          <FaBath className="text-primary-text w-4 h-4 shrink-0" />
                        }
                        text={`${selectedProperty?.property?.bathrooms} Bath`}
                      />
                      <Pill
                        icon={
                          <IoPerson className="text-primary-text w-4 h-4 shrink-0" />
                        }
                        text={`Sleeps ${selectedProperty?.property?.sleeps}`}
                      />
                    </div>
                    <div className="flex flex-row gap-2 mb-2 flex-wrap">
                      {selectedProperty?.KeyCodes?.length > 0 &&
                        selectedProperty.KeyCodes.map((keyCode, index) => (
                          <Pill
                            key={index}
                            icon={
                              <IoKeySharp className="text-primary-text w-4 h-4 shrink-0" />
                            }
                            color="purple"
                            text={`${keyCode.name}: ${keyCode.code}`}
                          />
                        ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex h-200 gap-6 flex-col bg-primary-bg rounded-2xl border border-border-color overflow-hidden items-center justify-center p-5 text-center">
                  <p className="text-primary-text">
                    This owner has no properties assigned.
                  </p>
                  <CTAButton
                    width="w-full"
                    type="main"
                    text="Assign Property"
                    icon={BsHouseAdd}
                  />
                </div>
              )}
              <PropertyNavigation
                onPrev={handlePrev}
                onNext={handleNext}
                currentIndex={currentIndex + 1}
                total={properties?.length || 0}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default OwnerDetails;
