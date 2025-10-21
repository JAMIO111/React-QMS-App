import { useForm, Controller, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { PropertyFormSchema } from "../validationSchema";
import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { IoIosMan } from "react-icons/io";
import { FaBed, FaBath, FaCheck, FaTreeCity } from "react-icons/fa6";
import { IoTrashOutline } from "react-icons/io5";
import { IoIosUndo } from "react-icons/io";
import { BsMailbox2Flag, BsFillBuildingsFill, BsPencil } from "react-icons/bs";
import { IoLocation } from "react-icons/io5";
import { PiNumberThreeFill } from "react-icons/pi";
import { GiFamilyHouse } from "react-icons/gi";
import NumericInputGroup from "./NumericInputGroup";
import TextInput from "./ui/TextInput";
import { usePropertyById } from "@/hooks/usePropertyById";
import CTAButton from "./CTAButton";
import { useModal } from "@/contexts/ModalContext";
import KeyCodeForm from "./KeyCodeForm";
import { useUpsertProperty } from "@/hooks/useUpsertProperty";

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
  KeyCodes: [],
  Owners: [],
};

const PropertyForm = () => {
  const { openModal, closeModal } = useModal();
  const navigate = useNavigate();
  const { id } = useParams();
  const { data: property, isLoading } = usePropertyById(
    id !== "New-Property" ? id : null
  );
  console.log("Property Data:", property);
  const upsertProperty = useUpsertProperty();

  const normalizedProperty = {
    ...property,
    line_1: property?.line_1 || undefined,
    line_2: property?.line_2 || undefined,
  };

  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    trigger,
    watch,
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
  } = useFieldArray({
    control,
    name: "Owners",
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

  return (
    <div className="flex bg-primary-bg flex-1 flex-row p-3 gap-3">
      <div className="flex flex-1 gap-3 flex-col">
        <div className="flex flex-1 justify-between flex-col bg-secondary-bg shadow-m rounded-2xl p-3">
          <img
            className="border border-border-color aspect-video rounded-xl"
            src={"/mansion-1.png"}
            alt={"Property Image"}
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
                  icon={GiFamilyHouse}
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
        <div className="flex h-full justify-between flex-1 p-5 flex-col bg-secondary-bg shadow-m rounded-2xl">
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
      <div className="flex flex-col flex-1 gap-3"></div>
      <div className="flex flex-col flex-1 gap-3">
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
                  <span className="flex-1 p-1 font-medium text-lg text-primary-text">
                    {field.name}
                  </span>
                  {field.is_private && (
                    <span className="rounded-lg p-1 text-primary-text shadow-s px-2 bg-pink-500/30 font-medium">
                      Private
                    </span>
                  )}
                  <CTAButton
                    borderRadius="rounded-lg"
                    title="Edit Key Code"
                    width="w-9"
                    height="h-9"
                    type="main"
                    className="text-sm text-red-500"
                    callbackFn={() => openEditKeyCodeModal(index, field)}
                    icon={BsPencil}
                  />
                  <CTAButton
                    borderRadius="rounded-lg"
                    title="Delete Key Code"
                    width="w-9"
                    height="h-9"
                    type="cancel"
                    className="text-sm text-red-500"
                    callbackFn={() => removeKeyCode(index)}
                    icon={IoTrashOutline}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col flex-1 bg-secondary-bg shadow-m rounded-2xl p-3"></div>
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
            disabled={
              !isDirty || !isValid || isSubmitting || upsertProperty.isLoading
            }
            width="flex-1"
            type="success"
            text={upsertProperty.isLoading ? "Saving..." : "Save Changes"}
            icon={FaCheck}
            callbackFn={handleSubmit(async (data) => {
              try {
                const payload = id !== "New-Property" ? { id, ...data } : data;

                console.log("Submitting payload:", payload);
                console.log("KeyCodes to submit:", keyCodeFields);
                await upsertProperty.mutateAsync({
                  propertyData: payload,
                  keyCodesForm: keyCodeFields,
                });

                navigate("/Client-Management/Properties");
              } catch (error) {
                console.error("Save failed:", error.message);
                alert("Failed to save property: " + error.message);
              }
            })}
          />
        </div>
      </div>
    </div>
  );
};

export default PropertyForm;
