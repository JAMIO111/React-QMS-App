import { BsPencil, BsFillPersonVcardFill } from "react-icons/bs";
import CTAButton from "./CTAButton";
import { TfiEmail } from "react-icons/tfi";
import { IoLocationOutline, IoPerson } from "react-icons/io5";
import { useOwnersByProperty } from "@/hooks/useOwnersByProperty";
import { useNavigate } from "react-router-dom";
import Pill from "@components/Pill";
import { FaBed, FaBath } from "react-icons/fa6";
import { HiOutlinePhone } from "react-icons/hi2";
import { IoKeySharp } from "react-icons/io5";
import PackagePill from "./PackagePill";

const PropertyDetails = ({ property, selectedProperty }) => {
  const navigate = useNavigate();
  const { data: owners, isLoading } = useOwnersByProperty(property?.id);
  console.log("Owners:", owners);

  return (
    <div className="bg-secondary-bg flex-1 h-full flex flex-col rounded-2xl shadow-m overflow-hidden">
      {!selectedProperty ? (
        <div className="w-full h-full flex items-center justify-center">
          <div className="gap-5 flex flex-col text-primary-text text-xl text-center border border-border-color bg-primary-bg p-10 rounded-xl">
            <p>No property selected</p>
            <p>Select a property to view details</p>
          </div>
        </div>
      ) : (
        <>
          {/* Header */}
          <div className="flex h-16 flex-row gap-3 items-center px-4 py-3 border-b border-border-color shrink-0">
            <BsFillPersonVcardFill className="w-7 h-7 text-primary-text" />
            <h2 className="text-xl flex-1 text-primary-text font-semibold">
              Property Details
            </h2>
            <CTAButton
              type="main"
              icon={BsPencil}
              text="Edit Property Details"
              callbackFn={() =>
                navigate(`/Client-Management/Properties/${property?.id}`)
              }
            />
          </div>
          <div className="flex overflow-y-auto flex-col">
            <div className="relative w-full">
              {property?.avatar ? (
                <img
                  className="aspect-video w-full object-cover"
                  src={property?.avatar}
                  alt={property?.name}
                />
              ) : (
                <div className="h-64 w-full bg-tertiary-bg flex items-center justify-center">
                  <span className="text-primary-text">No Image</span>
                </div>
              )}
              <div className="absolute z-10 rounded-xl justify-end bottom-0 left-5 border border-black bg-black/30 px-3 py-1">
                <p className="text-xl text-white font-semibold">
                  {property?.name}
                </p>
              </div>
              <PackagePill
                className="absolute top-5 left-5"
                maintPackage={property?.Packages}
              />
              <div className="absolute flex px-4 flex-col justify-end h-1/2 bottom-0 left-0 w-full z-0 bg-gradient-to-b from-transparent via-secondary-bg/80 to-secondary-bg py-1"></div>
            </div>
            <div className="p-4 pt-3 flex flex-col">
              <div className="flex flex-row mb-3 items-start gap-2">
                <IoLocationOutline className="text-primary-text mt-0.5 w-6 h-6 shrink-0" />
                <a
                  href={`https://what3words.com/${property?.what_3_words}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-text hover:text-brand-primary cursor-pointer text-lg underline">
                  {[
                    property?.line_1,
                    property?.line_2,
                    property?.town,
                    property?.county,
                    property?.postcode,
                  ]
                    .filter(Boolean) // removes null, undefined, and empty strings
                    .join(", ")}
                </a>
              </div>
              <div className="flex my-5 flex-wrap flex-row gap-4">
                {/* Base property pills */}
                <Pill
                  icon={
                    <FaBed className="text-primary-text w-4 h-4 shrink-0" />
                  }
                  text={`${property?.bedrooms} Bed`}
                />
                <Pill
                  icon={
                    <IoPerson className="text-primary-text w-4 h-4 shrink-0" />
                  }
                  text={`Sleeps ${property?.sleeps}`}
                />
                <Pill
                  icon={
                    <FaBath className="text-primary-text w-4 h-4 shrink-0" />
                  }
                  text={`${property?.bathrooms} Bath`}
                />

                {/* Key code pills (inline with the rest) */}
                {property?.KeyCodes?.length > 0 &&
                  property.KeyCodes.map((keyCode, index) => (
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
              <p className="text-xl text-primary-text font-semibold">
                Property Owners
              </p>
              {owners?.map((owner) => (
                <div className="mt-3 flex rounded-2xl border border-brand-primary/30 bg-brand-primary/20 p-2 flex-row gap-2">
                  {owner.avatar ? (
                    <img
                      className="rounded-xl w-24 h-24 object-cover"
                      src={owner?.avatar}
                      alt={owner?.first_name}
                    />
                  ) : (
                    <div className="rounded-xl w-24 h-24 bg-secondary-bg flex items-center justify-center">
                      <p className="text-secondary-text text-2xl">
                        {owner?.owner?.first_name?.charAt(0)}
                        {owner?.owner?.surname?.charAt(0)}{" "}
                      </p>
                    </div>
                  )}
                  <div className="ml-2 flex flex-1 flex-col gap-2 h-full justify-around min-w-0">
                    <div className="flex items-center gap-3">
                      <BsFillPersonVcardFill className="text-primary-text w-6 h-6 shrink-0" />
                      <p
                        className="text-xl truncate min-w-0 text-primary-text font-semibold text-left"
                        title={`${owner?.owner?.first_name} ${owner?.owner?.surname}`}>
                        {owner?.owner?.first_name} {owner?.owner?.surname}
                      </p>
                    </div>

                    <div className="flex items-center gap-3">
                      <HiOutlinePhone className="text-primary-text w-6 h-6 shrink-0" />
                      <p
                        className="truncate min-w-0 text-lg text-primary-text font-medium text-left"
                        title={owner?.owner?.primary_phone}>
                        {owner?.owner?.primary_phone || "No Phone"}
                      </p>
                    </div>

                    {/* Email */}
                    <div className="flex items-center gap-3 max-w-full">
                      <TfiEmail className="text-primary-text w-5 h-5 shrink-0" />
                      <p
                        className="ml-1 truncate text-sm text-primary-text text-left min-w-0"
                        title={owner?.owner?.primary_email}>
                        {owner?.owner?.primary_email || "No Email"}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 h-full justify-around">
                    <CTAButton
                      width="full"
                      type="success"
                      text="View details"
                      callbackFn={() =>
                        navigate(`/Client-Management/Owners`, {
                          state: { owner: owner?.owner },
                        })
                      }
                    />
                    <CTAButton
                      width="full"
                      type="neutral"
                      text="Edit details"
                      callbackFn={() =>
                        navigate(
                          `/Client-Management/Owners/${owner?.owner?.id}`
                        )
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default PropertyDetails;
