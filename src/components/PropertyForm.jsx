import { useForm, Controller, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { PropertyFormSchema } from "../validationSchema";
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { IoIosMan, IoIosUndo } from "react-icons/io";
import { FaBed, FaBath, FaCheck, FaTreeCity } from "react-icons/fa6";
import { IoTrashOutline, IoLocation, IoHome } from "react-icons/io5";
import { BsMailbox2Flag, BsFillBuildingsFill, BsPencil } from "react-icons/bs";
import { PiNumberThreeFill } from "react-icons/pi";
import { GiMagicBroom } from "react-icons/gi";
import NumericInputGroup from "./NumericInputGroup";
import TextInput from "./ui/TextInput";
import { usePropertyById } from "@/hooks/usePropertyById";
import CTAButton from "./CTAButton";
import { useModal } from "@/contexts/ModalContext";
import KeyCodeForm from "./KeyCodeForm";
import PropertyOwnerForm from "./PropertyOwnerForm";
import { useUpsertProperty } from "@/hooks/useUpsertProperty";
import CardSelect from "@components/CardSelect";
import { usePackages } from "@/hooks/useManagementPackages";
import { HiOutlinePhone } from "react-icons/hi2";
import { HiOutlineMail } from "react-icons/hi";
import {
  MdHotTub,
  MdOutlineLocalLaundryService,
  MdPublishedWithChanges,
} from "react-icons/md";
import Spinner from "@components/LoadingSpinner";
import { useToast } from "../contexts/ToastProvider";
import ToggleButton from "./ui/ToggleButton";
import ProfileImageSection from "./ProfileImageSection";
import { useQueryClient } from "@tanstack/react-query";

const defaultFormData = {
  name: undefined,
  bedrooms: 0,
  sleeps: 0,
  bathrooms: 0,
  line_1: undefined,
  line_2: undefined,
  town: undefined,
  county: undefined,
  postcode: undefined,
  what_3_words: undefined,
  package: null,
  service_type: null,
  KeyCodes: [],
  Owners: [],
};

const PropertyForm = () => {
  const queryClient = useQueryClient();
  const { openModal, closeModal } = useModal();
  const navigate = useNavigate();
  const { id } = useParams();
  const { showToast } = useToast();
  const { data: property, isLoading } = usePropertyById(
    id !== "New-Property" ? id : null
  );
  const { data: packages } = usePackages();
  console.log("Property Data:", property);
  console.log("Packages Data:", packages);
  const upsertProperty = useUpsertProperty();

  const normalizedProperty = {
    ...property,
    line_1: property?.line_1 || undefined,
    line_2: property?.line_2 || undefined,
  };

  const {
    control,
    handleSubmit,
    reset,
    trigger,
    formState: { errors, isSubmitting, isValid, isDirty },
  } = useForm({
    resolver: zodResolver(PropertyFormSchema),
    mode: "all",
    defaultValues: defaultFormData,
    delayError: 250,
  });

  const {
    fields: keyCodeFields,
    append: appendKeyCode,
    remove: removeKeyCode,
    update: updateKeyCode,
  } = useFieldArray({
    control,
    name: "KeyCodes",
  });

  const {
    fields: ownerFields,
    append: appendOwner,
    remove: removeOwner,
    update: updateOwner,
    replace: replaceOwners,
  } = useFieldArray({
    control,
    name: "Owners",
    keyName: "formId",
  });

  useEffect(() => {
    if (id === "New-Property") {
      reset(defaultFormData);
    } else if (property) {
      reset(normalizedProperty);
    }
  }, [id, property, reset]);

  console.log("Form Errors:", errors);
  console.log("Is Form Valid:", isValid);
  console.log("Is Form Dirty:", isDirty);

  console.log("KeyCode Fields:", keyCodeFields);
  console.log("Owner Fields:", ownerFields);

  const openManageOwnersModal = () => {
    openModal({
      title: "Manage Property Owners",
      content: (
        <PropertyOwnerForm
          propertyId={id}
          defaultOwners={ownerFields.map((field) => field)}
          onSave={(updatedOwners) => {
            replaceOwners(updatedOwners); // replaces entire array in form state
            trigger("Owners");
            closeModal();
          }}
          onCancel={closeModal}
        />
      ),
    });
  };

  const openAddKeyCodeModal = () => {
    openModal({
      title: "Add Key Code",
      content: (
        <KeyCodeForm
          onSave={(keyCode) => {
            appendKeyCode(keyCode);
            trigger("KeyCodes");
            closeModal();
          }}
          onCancel={closeModal}
        />
      ),
    });
  };

  const openEditKeyCodeModal = (index, keyCodeItem) => {
    openModal({
      title: "Edit Key Code",
      content: (
        <KeyCodeForm
          defaultValues={keyCodeItem}
          onSave={(updatedKeyCode) => {
            updateKeyCode(index, updatedKeyCode); // <-- use update for edits
            trigger("KeyCodes");
            closeModal();
          }}
          onCancel={closeModal}
        />
      ),
    });
  };

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex bg-primary-bg h-full flex-row p-3 gap-3">
      <div className="flex flex-1 gap-3 flex-col">
        <div className="flex flex-1 justify-between flex-col bg-secondary-bg shadow-m rounded-2xl p-3">
          <ProfileImageSection
            item={property}
            bucket="avatars"
            path="properties"
            table="Properties"
            noImageText="No Image"
            aspectRatio="aspect-video"
            width="w-full"
            onImageChange={(url) => {
              // Optional: update your parent state, e.g. via TanStack Query invalidate
              queryClient.invalidateQueries(["Property", property.id]);
              console.log("New avatar URL:", url);
            }}
          />
          <div className="my-3">
            <Controller
              name="name"
              control={control}
              render={({ field, fieldState }) => (
                <TextInput
                  label="Property Name"
                  placeholder="Enter property name..."
                  {...field}
                  icon={IoHome}
                  error={fieldState.error}
                />
              )}
            />
          </div>

          <Controller
            name="bedrooms"
            control={control}
            render={({ field, fieldState }) => (
              <NumericInputGroup
                label="Bedrooms"
                {...field}
                icon={FaBed}
                error={fieldState.error}
              />
            )}
          />

          <Controller
            name="sleeps"
            control={control}
            render={({ field, fieldState }) => (
              <NumericInputGroup
                label="Sleeps"
                {...field}
                icon={IoIosMan}
                error={fieldState.error}
              />
            )}
          />

          <Controller
            name="bathrooms"
            control={control}
            render={({ field, fieldState }) => (
              <NumericInputGroup
                label="Bathrooms"
                {...field}
                icon={FaBath}
                error={fieldState.error}
              />
            )}
          />
        </div>
      </div>
      <div className="flex-1">
        <div className="flex h-full justify-between flex-1 p-3 flex-col bg-secondary-bg shadow-m rounded-2xl">
          {[
            {
              name: "line_1",
              label: "Line 1",
              icon: IoLocation,
              textTransform: "capitalize",
            },
            {
              name: "line_2",
              label: "Line 2",
              icon: IoLocation,
              textTransform: "capitalize",
            },
            {
              name: "town",
              label: "Town",
              icon: BsFillBuildingsFill,
              textTransform: "capitalize",
            },
            {
              name: "county",
              label: "County",
              icon: FaTreeCity,
              textTransform: "capitalize",
            },
            {
              name: "postcode",
              label: "Postcode",
              icon: BsMailbox2Flag,
              textTransform: "uppercase",
            },
            {
              name: "what_3_words",
              label: "What 3 Words",
              icon: PiNumberThreeFill,
              textTransform: "lowercase",
            },
          ].map((input) => (
            <Controller
              key={input.name}
              name={input.name}
              control={control}
              render={({ field, fieldState }) => (
                <TextInput
                  label={input.label}
                  placeholder={`Enter ${input.label.toLowerCase()}...`}
                  {...field}
                  icon={input.icon}
                  error={fieldState.error}
                  textTransform={input.textTransform}
                />
              )}
            />
          ))}
        </div>
      </div>
      <div className="flex flex-col flex-1 gap-3">
        <div className="flex justify-between p-3 flex-col bg-secondary-bg shadow-m rounded-2xl">
          <Controller
            name="package"
            control={control}
            render={({ field, fieldState }) => (
              <CardSelect
                options={packages || []}
                label="Management Package"
                titleKey="name"
                descriptionKey="tier"
                valueKey="id"
                package={true}
                value={field.value}
                onChange={field.onChange}
              />
            )}
          />
        </div>
        <div className="flex flex-1 justify-start gap-3 p-3 flex-col bg-secondary-bg shadow-m rounded-2xl">
          <Controller
            name="service_type"
            control={control}
            render={({ field, fieldState }) => (
              <CardSelect
                options={[
                  {
                    id: "changeover",
                    name: "Changeover",
                    icon: MdPublishedWithChanges,
                  },
                  { id: "hot_tub", name: "Hot Tub", icon: MdHotTub },
                  {
                    id: "laundry",
                    name: "Laundry",
                    icon: MdOutlineLocalLaundryService,
                  },
                  { id: "clean", name: "Clean", icon: GiMagicBroom },
                ]}
                label="Service Type"
                titleKey="name"
                descriptionKey="tier"
                valueKey="id"
                value={field.value}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            name="hired_laundry"
            control={control}
            render={({ field, fieldState }) => (
              <ToggleButton
                label="Hired Laundry"
                checked={field.value}
                onChange={field.onChange}
                trueLabel="Yes"
                falseLabel="No"
                icon={MdOutlineLocalLaundryService}
              />
            )}
          />
        </div>
      </div>
      <div className="flex flex-col h-full gap-3">
        <div className="flex justify-between p-3 flex-col bg-secondary-bg shadow-m rounded-2xl">
          <div className="flex items-center justify-between pr-2 mb-3">
            <h2 className="text-xl ml-1 font-semibold text-primary-text">
              Key Codes
            </h2>
            <CTAButton
              type="main"
              text="Add Key Code"
              callbackFn={openAddKeyCodeModal}
            />
          </div>
          {keyCodeFields?.length === 0 ? (
            <p className="text-sm text-primary-text">No key codes added yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 max-h-28 overflow-y-auto">
              {keyCodeFields.map((field, index) => (
                <li
                  key={field.id}
                  className="flex mb-1 ml-1 shadow-s bg-tertiary-bg rounded-xl gap-2 p-1.5 mr-2 items-center justify-between">
                  <span className="rounded-lg shadow-s p-1 text-lg px-2 bg-primary-bg font-bold text-primary-text">
                    {field.code}
                  </span>
                  <span className="flex-1 p-1 truncate font-medium text-lg text-primary-text">
                    {field.name}
                  </span>
                  {field.is_private && (
                    <span className="rounded-lg p-1 text-primary-text shadow-s px-2 bg-pink-500/30 font-medium">
                      Private
                    </span>
                  )}

                  <button
                    onClick={() => openEditKeyCodeModal(index, field)}
                    className="p-2 cursor-pointer text-icon-color hover:shadow-s rounded-lg hover:text-cta-color">
                    <BsPencil className="h-5 w-5" />
                  </button>

                  <button
                    onClick={() => removeKeyCode(index)}
                    className="p-2 cursor-pointer hover:shadow-s text-icon-color rounded-lg hover:text-error-color">
                    <IoTrashOutline className="h-5 w-5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col flex-1 overflow-y-auto bg-secondary-bg shadow-m rounded-2xl p-3">
          <div className="flex items-center justify-between pr-2 mb-3">
            <h2 className="text-xl ml-1 font-semibold text-primary-text">
              Owners
            </h2>
            <CTAButton
              type="main"
              text="Manage Owners"
              callbackFn={openManageOwnersModal}
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {ownerFields.length === 0 ? (
              <p className="text-sm text-primary-text">No owners added yet.</p>
            ) : (
              <ul className="flex flex-col p-1 gap-2">
                {ownerFields.map((owner, index) => (
                  <li
                    key={owner.id}
                    className="flex items-center justify-between p-2 bg-tertiary-bg rounded-xl shadow-s">
                    {owner.avatar ? (
                      <img
                        src={owner.avatar}
                        alt={`${owner.first_name} ${owner.surname}`}
                        className="w-12 h-12 rounded-lg object-cover mr-3"
                      />
                    ) : (
                      <div className="flex items-center justify-center shadow-s w-12 h-12 rounded-lg bg-primary-bg mr-3">
                        <p className="text-lg font-semibold text-primary-text">
                          {owner.first_name.charAt(0).toUpperCase() +
                            owner.surname.charAt(0).toUpperCase()}
                        </p>
                      </div>
                    )}
                    <div className="flex flex-col gap-1 flex-1 ml-2">
                      <span className="font-medium text-primary-text">
                        {owner.first_name} {owner.surname}
                      </span>
                      <div className="flex items-center gap-2">
                        {owner.primary_email ? (
                          <HiOutlineMail className="text-secondary-text" />
                        ) : (
                          <HiOutlinePhone className="text-secondary-text" />
                        )}
                        <span className="text-sm text-secondary-text">
                          {owner.primary_email
                            ? owner.primary_email
                            : owner.primary_phone}
                        </span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="flex flex-row gap-3 bg-secondary-bg shadow-m rounded-2xl p-3">
          <CTAButton
            disabled={!isDirty}
            width="flex-1"
            type="cancel"
            text="Revert Changes"
            icon={IoIosUndo}
            callbackFn={() =>
              id === "New-Property"
                ? reset(defaultFormData)
                : reset(normalizedProperty)
            }
          />
          <CTAButton
            disabled={!isDirty || !isValid || isSubmitting}
            width="flex-1"
            type="success"
            text={isSubmitting ? "Saving..." : "Save Changes"}
            icon={FaCheck}
            callbackFn={handleSubmit(async (data) => {
              try {
                const payload =
                  id && id !== "New-Property" ? { ...data, id } : { ...data };

                await upsertProperty.mutateAsync({
                  propertyData: payload,
                  keyCodesForm: keyCodeFields,
                  ownersForm: ownerFields,
                });

                showToast({
                  type: "success",
                  title: id ? "Property Updated" : "Property Created",
                  message: id
                    ? "The property has been successfully updated."
                    : "New property successfully entered.",
                });

                navigate("/Client-Management/Properties");
              } catch (error) {
                console.error("Save failed:", error.message);

                showToast({
                  type: "error",
                  title: "Save Failed",
                  message:
                    error?.message ||
                    "An unexpected error occurred while saving.",
                });
              }
            })}
          />
        </div>
      </div>
    </div>
  );
};

export default PropertyForm;
